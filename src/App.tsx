/**
 * Sift — chat-first, folder-as-project AI video editor.
 *
 * Layout (post-UX-pivot):
 *   • Left:   FolderPane
 *   • Center: tabs → Player (default) | Transcript (existing editor)
 *   • Right:  ChatPanel (primary editing surface; stub responses for M-A)
 *
 * The whole-cut auto-render that used to fire on every engine head
 * change is gone — it choked FFmpeg on long transcripts. Instead the
 * chat panel renders just the snippet range an AI message proposes.
 * Export still renders the full cut, but only on user action.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { exists } from "@tauri-apps/plugin-fs";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileCode2,
  Loader2,
  Play,
  Undo2,
  Video,
} from "lucide-react";

import { FolderPane } from "./components/FolderPane";
import { VideoPlayer } from "./components/VideoPlayer";
import { CenterTabs, type CenterTab } from "./components/CenterTabs";
import { ChatPanel, type ChatMessage } from "./components/ChatPanel";
import { TopBar } from "./components/TopBar";
import { TranscriptEditorPane } from "./components/TranscriptEditorPane";
import { CutListPane } from "./components/CutListPane";
import { FirstRunOverlay } from "./components/FirstRunOverlay";
import { dismissOnboardingPersist, readOnboardingDismissed } from "./lib/onboardingStorage";
import { useEngineProject } from "./lib/useEngineProject";
import { loadStoredWhisperModel, saveStoredWhisperModel } from "./lib/whisperModels";
import { ulidLite } from "./lib/ulid";
import type { FolderProject } from "./lib/folderProject";
import { ensureProjectsDir, getVideoProjectPath } from "./lib/perVideoProject";
import {
  buildRangeDeleteOps,
  buildWordIndexDeleteOps,
  type TranscriptHandle,
  type TranscriptState,
} from "./lib/transcriptOps";
import type { Op } from "./lib/ops";
import {
  AIServiceError,
  getAIClient,
  type PlanChatTurnPayload,
  type PlanKeptRangePayload,
} from "./lib/aiClient";
import type { RenderRangesResult } from "./lib/engineClient";
import type { Transcript } from "./lib/aiClient";
import { computeSnippetRangesAfterDeletes } from "./lib/previewSnippet";
import {
  buildPreviewRangesFromEngine,
  previewFileToBlobUrl,
  renderPreviewToFile,
  type PreviewRenderRange,
} from "./lib/previewRender";
import { buildFcpxml, rangesFromRenderResult } from "./lib/fcpxml";
import { useTranscriptionQueue } from "./lib/transcriptionQueue";
import { useSiftAiHealth } from "./lib/siftAiHealth";

// ── Resolution picker ────────────────────────────────────────────────
// Each tier is `(label, maxEdge)` — maxEdge is the long-edge cap
// passed through to FFmpeg's scale filter in preview_render.rs.
const RESOLUTION_TIERS: ReadonlyArray<{ label: string; maxEdge: number }> = [
  { label: "360p", maxEdge: 640 },
  { label: "480p", maxEdge: 854 },
  { label: "720p", maxEdge: 1280 },
  { label: "1080p", maxEdge: 1920 },
  { label: "1440p", maxEdge: 2560 },
  { label: "4K", maxEdge: 3840 },
];
const RESOLUTION_STORAGE_KEY = "sift.resolution.maxEdge.v1";

// ── Layout (collapsed + widths) ──────────────────────────────────────
const LAYOUT_STORAGE_KEY = "sift.layout.v1";
const LEFT_DEFAULT = 248;
const RIGHT_DEFAULT = 312;
const LEFT_MIN = 180;
const LEFT_MAX = 520;
const RIGHT_MIN = 240;
const RIGHT_MAX = 620;

interface LayoutState {
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}

function readLayout(): LayoutState {
  if (typeof window === "undefined") {
    return {
      leftWidth: LEFT_DEFAULT,
      rightWidth: RIGHT_DEFAULT,
      leftCollapsed: false,
      rightCollapsed: false,
    };
  }
  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) throw new Error("no layout");
    const v = JSON.parse(raw) as Partial<LayoutState>;
    return {
      leftWidth: clampWidth(v.leftWidth ?? LEFT_DEFAULT, LEFT_MIN, LEFT_MAX),
      rightWidth: clampWidth(v.rightWidth ?? RIGHT_DEFAULT, RIGHT_MIN, RIGHT_MAX),
      leftCollapsed: Boolean(v.leftCollapsed),
      rightCollapsed: Boolean(v.rightCollapsed),
    };
  } catch {
    return {
      leftWidth: LEFT_DEFAULT,
      rightWidth: RIGHT_DEFAULT,
      leftCollapsed: false,
      rightCollapsed: false,
    };
  }
}

function clampWidth(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * Result of mapping one of Claude's tool calls onto a concrete engine
 * proposal that the existing approve flow can apply.
 *
 * `ops` — straight clip_delete batch (delete_words / delete_range).
 * `undo` — translates to `project.undo()` on Approve.
 * `non_actionable` — Claude responded with text only or with a tool
 * call that resolved to zero matching words / a bad range.
 */
type ResolvedProposal =
  | {
      kind: "ops";
      body: string;
      ops: Op[];
      deletedWordIndices: number[];
      caption: string;
    }
  | { kind: "undo"; body: string; caption: string }
  | { kind: "non_actionable"; body: string };

/** Map an `op` chunk's payload to a `ResolvedProposal`. Pure function. */
function resolveClaudeAction(
  payload: Record<string, unknown>,
  transcriptState: TranscriptState,
  rationale: string,
): ResolvedProposal {
  const action = payload.action;
  const reason =
    typeof payload.reason === "string" && payload.reason.trim().length > 0
      ? payload.reason
      : rationale;
  const body = reason.trim().length > 0 ? reason : `Action: ${String(action)}`;

  if (action === "undo") {
    return {
      kind: "undo",
      body,
      caption: "Proposed: undo last edit",
    };
  }
  if (action === "delete_words") {
    const indices = Array.isArray(payload.word_indices)
      ? (payload.word_indices as unknown[]).filter(
          (n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0,
        )
      : [];
    const { ops, wordIndices } = buildWordIndexDeleteOps(transcriptState, indices);
    if (ops.length === 0) {
      return {
        kind: "non_actionable",
        body: `${body}\n\n(No matching words to remove — they may already be deleted.)`,
      };
    }
    return {
      kind: "ops",
      body,
      ops,
      deletedWordIndices: wordIndices,
      caption: `Proposed edit · ${ops.length} word${ops.length === 1 ? "" : "s"} to remove`,
    };
  }
  if (action === "delete_range") {
    const start = Number(payload.start_secs);
    const end = Number(payload.end_secs);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return {
        kind: "non_actionable",
        body: `${body}\n\n(Claude returned an invalid time range.)`,
      };
    }
    const { ops, wordIndices } = buildRangeDeleteOps(transcriptState, start, end);
    if (ops.length === 0) {
      return {
        kind: "non_actionable",
        body: `${body}\n\n(No words sit fully inside that range.)`,
      };
    }
    return {
      kind: "ops",
      body,
      ops,
      deletedWordIndices: wordIndices,
      caption: `Proposed edit · ${ops.length} word${ops.length === 1 ? "" : "s"} in range`,
    };
  }

  return {
    kind: "non_actionable",
    body: body || `Unknown action from Claude: ${String(action)}`,
  };
}

/**
 * Probe a video file for duration + intrinsic dimensions by loading
 * its metadata into a temporary `<video>` element. Used by the
 * FCPXML exporter so the emitted asset length matches the source.
 * Frame rate isn't exposed by the DOM video API; the caller picks a
 * default and the user can adjust in their NLE if needed.
 */
async function probeVideoMeta(absPath: string): Promise<{
  durationSecs: number;
  width: number;
  height: number;
  frameRate: number;
}> {
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.style.position = "absolute";
    v.style.visibility = "hidden";
    v.style.pointerEvents = "none";
    v.src = convertFileSrc(absPath);
    const cleanup = () => {
      v.removeEventListener("loadedmetadata", onLoad);
      v.removeEventListener("error", onError);
      try {
        v.remove();
      } catch {
        /* fine */
      }
    };
    const onLoad = () => {
      const dur = Number.isFinite(v.duration) ? v.duration : 0;
      const result = {
        durationSecs: dur,
        width: v.videoWidth,
        height: v.videoHeight,
        // We can't read frame rate from the DOM. Default to 30 — the
        // most common rate for screen recordings + modern web video.
        // Users with 24/25/29.97/60 sources can change the timebase
        // in their NLE after import.
        frameRate: 30,
      };
      cleanup();
      resolve(result);
    };
    const onError = () => {
      cleanup();
      reject(new Error("Couldn't probe source video metadata."));
    };
    v.addEventListener("loadedmetadata", onLoad);
    v.addEventListener("error", onError);
    document.body.appendChild(v);
  });
}

/** Strip directory parts. */
function basenameLite(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i === -1 ? p : p.slice(i + 1);
}

function readStoredMaxEdge(): number {
  if (typeof window === "undefined") return 1920;
  const raw = window.localStorage.getItem(RESOLUTION_STORAGE_KEY);
  if (!raw) return 1920;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 240 && n <= 4096 ? n : 1920;
}

export default function App() {
  const project = useEngineProject();
  const [bootstrapTranscribePath, setBootstrapTranscribePath] = useState<string | null>(null);
  const [whisperModel, setWhisperModel] = useState(loadStoredWhisperModel);
  const [onboardingOpen, setOnboardingOpen] = useState(() => !readOnboardingDismissed());

  // Folder-as-project (Milestone A).
  const [folder, setFolder] = useState<FolderProject | null>(null);
  const [activeVideoPath, setActiveVideoPath] = useState<string | null>(null);
  // Persistence-status hint shown in the top bar.
  const [persistenceStatus, setPersistenceStatus] = useState<
    "idle" | "loading" | "saving" | "saved" | "error"
  >("idle");
  // ── Per-video engine project files ────────────────────────────────
  // Each video in the folder gets its own `<siftPath>/projects/<slug>.json`.
  // Switching videos = save the CURRENT engine file first, then load
  // (or new+save) the next one. Without this the engine state of the
  // outgoing video would be clobbered by the next ingest pipeline.
  const activeProjectFilePath = useMemo(() => {
    if (!folder || !activeVideoPath) return null;
    return getVideoProjectPath(folder.siftPath, activeVideoPath);
  }, [folder, activeVideoPath]);
  // The path we most recently *loaded* the engine from. Used to flush
  // pending state to the OLD path before switching to a new video.
  const loadedProjectFilePathRef = useRef<string | null>(null);

  useEffect(() => {
    if (!folder || !activeProjectFilePath || !activeVideoPath) {
      loadedProjectFilePathRef.current = null;
      setPersistenceStatus("idle");
      return;
    }
    if (loadedProjectFilePathRef.current === activeProjectFilePath) return;
    const previousPath = loadedProjectFilePathRef.current;
    loadedProjectFilePathRef.current = activeProjectFilePath;

    let cancelled = false;
    (async () => {
      setPersistenceStatus("loading");
      try {
        await ensureProjectsDir(folder.siftPath);
        // Flush the outgoing video's edits before swapping.
        if (previousPath !== null) {
          console.log(
            `[sift] switch: flushing outgoing engine state to ${previousPath}`,
          );
          const saveR = await project.saveProjectToPath(previousPath);
          console.log(
            `[sift] switch: flush ${saveR.ok ? "ok" : "FAILED: " + saveR.error}`,
          );
        }
        if (cancelled) return;
        const has = await exists(activeProjectFilePath).catch(() => false);
        if (cancelled) return;
        if (has) {
          console.log(`[sift] switch: loading ${activeProjectFilePath}`);
          const r = await project.loadProjectFromPath(activeProjectFilePath);
          if (cancelled) return;
          console.log(
            `[sift] switch: load ${r.ok ? "ok" : "FAILED: " + r.error}`,
          );
          setPersistenceStatus(r.ok ? "saved" : "error");
        } else {
          console.log(`[sift] switch: new project at ${activeProjectFilePath}`);
          const r = await project.newProjectAtPath(activeProjectFilePath);
          if (cancelled) return;
          setPersistenceStatus(r.ok ? "saved" : "error");
        }
        if (cancelled) return;
        // Tell the transcript pane to bootstrap *after* the engine is
        // in the right state. Doing this in the activeVideoPath effect
        // would race the load — the pane could see the old engine
        // (n_ops > 0 from the previous video) and rehydrate against
        // the wrong transcript, leaking edits across videos.
        setBootstrapTranscribePath(activeVideoPath);
      } catch (e) {
        console.error("[sift] switch: error", e);
        if (!cancelled) setPersistenceStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectFilePath, activeVideoPath, folder?.siftPath]);

  // ── Auto-save on every engine head change ─────────────────────────
  // Debounced so a multi-op batch (e.g. transcript ingest) collapses
  // into a single write.
  const headSig = `${project.head?.head ?? ""}|${project.head?.n_ops ?? 0}`;
  useEffect(() => {
    if (!activeProjectFilePath) return;
    if (!project.head) return;
    const path = activeProjectFilePath;
    const timer = window.setTimeout(async () => {
      setPersistenceStatus("saving");
      const r = await project.saveProjectToPath(path);
      setPersistenceStatus(r.ok ? "saved" : "error");
    }, 400);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headSig, activeProjectFilePath]);

  // Center pane tab state.
  const [activeTab, setActiveTab] = useState<CenterTab>("player");

  // Chat state — M-A stubs the planner. Real Claude lives in M-B.
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  // Proposals attached to assistant messages, keyed by message id.
  // Held outside ChatMessage state so we don't have to serialise
  // BigInt-shaped engine ops through React's state diffing. Tagged
  // union so Approve can branch between apply-batch and undo.
  type ChatProposal = { kind: "ops"; ops: Op[] } | { kind: "undo" };
  const proposedOpsRef = useRef<Map<string, ChatProposal>>(new Map());

  // Imperative handle to the transcript pane so the chat planner can
  // read the current transcript + ingest snapshot without prop traffic.
  const transcriptRef = useRef<TranscriptHandle>(null);
  // Blob URLs we've handed to the chat. Revoked on undo / replace.
  const snippetBlobUrlsRef = useRef<Set<string>>(new Set());

  // Folder-level transcription queue (M-A #6). Drains all videos in
  // the open folder through cache + Whisper concurrently in the
  // background; surfaces per-video status to the FolderPane.
  const transcriptionQueue = useTranscriptionQueue({
    siftPath: folder?.siftPath ?? null,
    whisperModel,
    concurrency: 2,
  });

  // Periodic probe of sift-ai. When down, FolderPane shows a banner
  // with the start command so the user isn't surprised by transcribe
  // failures later.
  const aiHealth = useSiftAiHealth();

  // Player mode: source video the Player tab is currently showing.
  // - "original": plays activeVideoPath (the source as-recorded).
  // - "cut":      plays the most recently rendered full flat cut.
  // Switching active video forces back to "original".
  type PlayerMode = "original" | "cut";
  const [playerMode, setPlayerMode] = useState<PlayerMode>("original");
  const [cutPlayerPath, setCutPlayerPath] = useState<string | null>(null);
  const [cutRendering, setCutRendering] = useState(false);
  const [cutError, setCutError] = useState<string | null>(null);

  // Export state — full-res render of the current cut to .sift/exports/.
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);

  // Cut-list tab state: live render plan + active transcript. We
  // pull the render plan from the engine every time the head changes
  // (debounced via headSig). The transcript is a snapshot updated by
  // an effect that watches transcriptRef + active video.
  const [cutListRanges, setCutListRanges] = useState<RenderRangesResult | null>(null);
  const [cutListTranscript, setCutListTranscript] = useState<Transcript | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await project.renderRanges();
      if (cancelled) return;
      setCutListRanges(r);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headSig]);
  useEffect(() => {
    const state = transcriptRef.current?.getState();
    setCutListTranscript(state?.transcript ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeVideoPath, headSig]);

  // ── Layout: collapsed panels + drag-to-resize widths ───────────────
  const [layout, setLayout] = useState<LayoutState>(readLayout);
  const dragRef = useRef<{
    side: "left" | "right";
    startX: number;
    startWidth: number;
  } | null>(null);
  // Persist layout changes to localStorage. The dependency array
  // intentionally watches each field so toggling collapse + resize
  // both write through.
  useEffect(() => {
    try {
      window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
    } catch {
      /* ignore quota errors — layout isn't critical */
    }
  }, [layout]);

  const onGutterPointerDown = useCallback(
    (side: "left" | "right") => (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      dragRef.current = {
        side,
        startX: e.clientX,
        startWidth: side === "left" ? layout.leftWidth : layout.rightWidth,
      };
    },
    [layout.leftWidth, layout.rightWidth],
  );
  const onGutterPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = dragRef.current;
      if (!d) return;
      const delta = e.clientX - d.startX;
      if (d.side === "left") {
        setLayout((prev) => ({
          ...prev,
          leftWidth: clampWidth(d.startWidth + delta, LEFT_MIN, LEFT_MAX),
        }));
      } else {
        // Right gutter: dragging right *shrinks* the right pane.
        setLayout((prev) => ({
          ...prev,
          rightWidth: clampWidth(d.startWidth - delta, RIGHT_MIN, RIGHT_MAX),
        }));
      }
    },
    [],
  );
  const onGutterPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      dragRef.current = null;
      try {
        (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
      } catch {
        /* ignore — capture may already be released */
      }
    },
    [],
  );
  const toggleLeftCollapse = useCallback(() => {
    setLayout((prev) => ({ ...prev, leftCollapsed: !prev.leftCollapsed }));
  }, []);
  const toggleRightCollapse = useCallback(() => {
    setLayout((prev) => ({ ...prev, rightCollapsed: !prev.rightCollapsed }));
  }, []);

  // ── Resolution picker ──────────────────────────────────────────────
  const [maxEdge, setMaxEdge] = useState<number>(readStoredMaxEdge);
  useEffect(() => {
    try {
      window.localStorage.setItem(RESOLUTION_STORAGE_KEY, String(maxEdge));
    } catch {
      /* ignore */
    }
  }, [maxEdge]);
  // Source resolution reported by <video onLoadedMetadata>.
  const [sourceResolution, setSourceResolution] = useState<{ w: number; h: number } | null>(null);
  const onResolutionDetected = useCallback((w: number, h: number) => {
    setSourceResolution({ w, h });
  }, []);
  useEffect(() => {
    // Clear stale resolution badge when the source changes.
    setSourceResolution(null);
  }, [activeVideoPath, playerMode, cutPlayerPath]);

  // Build the grid template string from current layout. When a side
  // is collapsed, the column becomes a 28px rail with an expand chevron.
  const gridTemplateColumns = useMemo(() => {
    const left = layout.leftCollapsed ? "28px" : `${layout.leftWidth}px`;
    const right = layout.rightCollapsed ? "28px" : `${layout.rightWidth}px`;
    return `${left} 1fr ${right}`;
  }, [layout]);

  // Switching to a different source resets the player to its original.
  // The transcript bootstrap kick-off lives in the per-video project
  // load effect above — that way the engine state is guaranteed to be
  // in place before TranscriptEditorPane decides whether to rehydrate
  // or re-ingest.
  useEffect(() => {
    setPlayerMode("original");
    setCutPlayerPath(null);
    setCutError(null);
  }, [activeVideoPath]);

  // Folder open / change → reset the transcription queue and enqueue
  // every video for background processing. Cache hits land in `ready`
  // instantly; misses go through Whisper at the configured concurrency.
  useEffect(() => {
    if (!folder) {
      transcriptionQueue.reset();
      return;
    }
    transcriptionQueue.reset();
    if (folder.videos.length > 0) {
      transcriptionQueue.enqueueAll(folder.videos.map((v) => v.path));
    }
    // We deliberately depend on folderPath (identity) — not the queue
    // object itself — so the queue isn't reset on every state diff.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder?.folderPath]);

  // Revoke any chat-snippet Blob URLs when the app unmounts.
  useEffect(() => {
    const urls = snippetBlobUrlsRef.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  const dismissOnboarding = useCallback(() => {
    dismissOnboardingPersist();
    setOnboardingOpen(false);
  }, []);

  const onWhisperModelChange = useCallback((modelId: string) => {
    setWhisperModel(modelId);
    saveStoredWhisperModel(modelId);
  }, []);

  // Keyboard shortcuts: tab switching + undo/redo + panel toggles.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "1") {
        e.preventDefault();
        setActiveTab("player");
        return;
      }
      if (mod && e.key === "2") {
        e.preventDefault();
        setActiveTab("transcript");
        return;
      }
      if (mod && e.key === "3") {
        e.preventDefault();
        setActiveTab("cutlist");
        return;
      }
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) void project.redo();
        else void project.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        void project.redo();
        return;
      }
      // ⌘B → toggle folder pane (mirrors VS Code's sidebar shortcut).
      if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleLeftCollapse();
        return;
      }
      // ⌘J → toggle chat pane (mirrors VS Code's panel shortcut).
      if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        toggleRightCollapse();
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [project, toggleLeftCollapse, toggleRightCollapse]);

  // M-B chat: stream a plan from Claude via sift-ai. Claude returns
  // text (rationale) + one tool call that we resolve to either a
  // clip_delete batch (delete_words / delete_range) or an undo. The
  // approve flow + snippet preview pipeline below is unchanged from
  // M-A — only the source of the proposal moved from a regex stub
  // to a real LLM.
  const onChatSubmit = useCallback(
    async (text: string) => {
      const transcriptState = transcriptRef.current?.getState();
      const userMsg: ChatMessage = {
        id: ulidLite(),
        role: "user",
        body: text,
        createdAt: Date.now(),
      };
      const msgId = ulidLite();
      const artifactId = `${msgId}-a`;
      // Capture prior chat turns BEFORE appending the new user message,
      // so we don't double-send it when the server formats the user
      // message body and appends it at the end of the Anthropic
      // messages list.
      const priorHistory: PlanChatTurnPayload[] = chatMessages.map((m) => ({
        role: m.role,
        content: m.body,
      }));
      setChatMessages((prev) => [
        ...prev,
        userMsg,
        {
          id: msgId,
          role: "assistant",
          body: "",
          createdAt: Date.now(),
        },
      ]);
      setChatBusy(true);

      if (!transcriptState) {
        setChatMessages((prev) =>
          prev.map((m) =>
            m.id !== msgId
              ? m
              : {
                  ...m,
                  body:
                    "There's no transcript loaded for the active video yet. "
                    + "Pick a video in the folder pane and wait for Whisper to finish.",
                },
          ),
        );
        setChatBusy(false);
        return;
      }

      // Build the current render plan for context. If the engine has
      // nothing yet we just send an empty list — Claude treats that as
      // "the whole transcript is in the cut".
      let renderPlan: PlanKeptRangePayload[] = [];
      try {
        const r = await project.renderRanges();
        renderPlan =
          r?.ranges.map((rg) => ({
            start_ticks: rg.start_ticks,
            end_ticks: rg.end_ticks,
          })) ?? [];
      } catch {
        renderPlan = [];
      }

      let rationale = "";
      let proposal: ResolvedProposal | null = null;
      let errored = false;

      try {
        for await (const chunk of getAIClient().plan({
          command: text,
          transcript: transcriptState.transcript,
          render_plan: renderPlan,
          chat_history: priorHistory,
        })) {
          if (chunk.type === "rationale") {
            const t =
              typeof chunk.payload.text === "string" ? chunk.payload.text : "";
            rationale += t;
            setChatMessages((prev) =>
              prev.map((m) => (m.id !== msgId ? m : { ...m, body: rationale })),
            );
          } else if (chunk.type === "op") {
            proposal = resolveClaudeAction(chunk.payload, transcriptState, rationale);
          } else if (chunk.type === "error") {
            const errMsg =
              typeof chunk.payload.message === "string"
                ? chunk.payload.message
                : "Unknown error.";
            rationale = `Sift couldn't reach Claude: ${errMsg}`;
            setChatMessages((prev) =>
              prev.map((m) => (m.id !== msgId ? m : { ...m, body: rationale })),
            );
            errored = true;
            break;
          }
          // "done" / "question" pass through silently.
        }
      } catch (e) {
        const errMsg =
          e instanceof AIServiceError
            ? `sift-ai ${e.status}: ${e.detail}`
            : e instanceof Error
              ? e.message
              : String(e);
        rationale = rationale
          ? `${rationale}\n\nStream interrupted: ${errMsg}`
          : `Sift couldn't reach Claude: ${errMsg}`;
        setChatMessages((prev) =>
          prev.map((m) => (m.id !== msgId ? m : { ...m, body: rationale })),
        );
        errored = true;
      }

      setChatBusy(false);
      if (errored || proposal === null) return;

      if (proposal.kind === "non_actionable") {
        const finalBody = proposal.body;
        setChatMessages((prev) =>
          prev.map((m) => (m.id !== msgId ? m : { ...m, body: finalBody })),
        );
        return;
      }

      if (proposal.kind === "undo") {
        proposedOpsRef.current.set(msgId, { kind: "undo" });
        setChatMessages((prev) =>
          prev.map((m) =>
            m.id !== msgId
              ? m
              : {
                  ...m,
                  body: proposal.body,
                  artifacts: [
                    {
                      id: artifactId,
                      caption: proposal.caption,
                      blobUrl: null,
                      rendering: false,
                      error: null,
                    },
                  ],
                },
          ),
        );
        return;
      }

      // proposal.kind === "ops"
      proposedOpsRef.current.set(msgId, { kind: "ops", ops: proposal.ops });
      const sourcePath = transcriptState.sourcePath ?? activeVideoPath ?? null;
      const canRenderSnippet =
        sourcePath !== null
        && folder !== null
        && proposal.deletedWordIndices.length > 0;

      setChatMessages((prev) =>
        prev.map((m) =>
          m.id !== msgId
            ? m
            : {
                ...m,
                body: proposal.body,
                artifacts: [
                  {
                    id: artifactId,
                    caption: proposal.caption,
                    blobUrl: null,
                    rendering: canRenderSnippet,
                    error: null,
                  },
                ],
              },
        ),
      );

      if (canRenderSnippet && sourcePath !== null && folder !== null) {
        const deletedIndices = proposal.deletedWordIndices;
        void (async () => {
          try {
            const ranges: PreviewRenderRange[] = computeSnippetRangesAfterDeletes(
              transcriptState,
              deletedIndices,
              sourcePath,
              { maxSecs: 15 },
            );
            if (ranges.length === 0) {
              setChatMessages((prev) =>
                prev.map((m) =>
                  m.id !== msgId
                    ? m
                    : {
                        ...m,
                        artifacts: m.artifacts?.map((a) =>
                          a.id !== artifactId
                            ? a
                            : {
                                ...a,
                                rendering: false,
                                error: "Proposal would empty the cut — nothing to preview.",
                              },
                        ),
                      },
                ),
              );
              return;
            }
            const outPath = `${folder.siftPath}/cache/snippet-${artifactId}.mp4`;
            const snippetEdge = Math.min(maxEdge, 1280);
            const result = await renderPreviewToFile(ranges, outPath, snippetEdge);
            const blobUrl = await previewFileToBlobUrl(result.output_path);
            snippetBlobUrlsRef.current.add(blobUrl);
            setChatMessages((prev) =>
              prev.map((m) =>
                m.id !== msgId
                  ? m
                  : {
                      ...m,
                      artifacts: m.artifacts?.map((a) =>
                        a.id !== artifactId
                          ? a
                          : { ...a, rendering: false, blobUrl, error: null },
                      ),
                    },
              ),
            );
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setChatMessages((prev) =>
              prev.map((m) =>
                m.id !== msgId
                  ? m
                  : {
                      ...m,
                      artifacts: m.artifacts?.map((a) =>
                        a.id !== artifactId
                          ? a
                          : { ...a, rendering: false, error: msg },
                      ),
                    },
              ),
            );
          }
        })();
      }
    },
    [activeVideoPath, folder, chatMessages, project, maxEdge],
  );

  const onChatApprove = useCallback(
    async (id: string) => {
      const proposal = proposedOpsRef.current.get(id);
      if (!proposal) return;
      if (proposal.kind === "undo") {
        const r = await project.undo();
        if (r === null) {
          setChatMessages((prev) =>
            prev.map((m) =>
              m.id === id
                ? { ...m, body: `${m.body}\n\nNothing to undo.` }
                : m,
            ),
          );
          return;
        }
        proposedOpsRef.current.delete(id);
        setChatMessages((prev) =>
          prev.map((m) => (m.id === id ? { ...m, applied: true } : m)),
        );
        return;
      }
      const ops = proposal.ops;
      if (ops.length === 0) return;
      const outcome = await project.applyBatch(ops, { group_undo: true });
      if (!outcome.ok) {
        setChatMessages((prev) =>
          prev.map((m) =>
            m.id === id
              ? {
                  ...m,
                  body: `${m.body}\n\nApply failed: ${outcome.error}`,
                }
              : m,
          ),
        );
        return;
      }
      // Successful apply — mark message and drop the cached ops so a
      // double-click doesn't re-apply.
      proposedOpsRef.current.delete(id);
      setChatMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, applied: true } : m)),
      );
    },
    [project],
  );

  const onChatUndo = useCallback((_id: string) => {
    // Per-message undo is intentionally not wired in M-A. The global
    // Undo button (top of the center pane) undoes the most recent
    // batch, which matches engine.undo() semantics.
    void project.undo();
  }, [project]);

  const onOpenSnippetInPlayer = useCallback((_artifact: unknown) => {
    setActiveTab("player");
    // M-B will route a snippet Blob URL into the player.
  }, []);

  // "Play current cut" — render the engine's full render plan to a
  // single MP4 on disk under `.sift/cache/`, then swap the player to
  // play it. Each click re-renders so the player reflects the latest
  // engine state on demand (we deliberately don't auto-render).
  const onPlayCurrentCut = useCallback(async () => {
    if (!folder || cutRendering) return;
    setCutRendering(true);
    setCutError(null);
    try {
      const ranges = await buildPreviewRangesFromEngine();
      if (ranges.length === 0) {
        setCutError("Empty timeline — nothing to play.");
        return;
      }
      const headId = project.head?.head ?? "head";
      const outPath = `${folder.siftPath}/cache/cut-${headId.slice(0, 16) || "init"}.mp4`;
      const result = await renderPreviewToFile(ranges, outPath, maxEdge);
      setCutPlayerPath(result.output_path);
      setPlayerMode("cut");
      setActiveTab("player");
    } catch (e) {
      setCutError(e instanceof Error ? e.message : String(e));
    } finally {
      setCutRendering(false);
    }
  }, [folder, project.head?.head, cutRendering, maxEdge]);

  const onShowOriginal = useCallback(() => {
    setPlayerMode("original");
    setCutError(null);
  }, []);

  const onExportCut = useCallback(async () => {
    if (!folder || exporting) return;
    setExporting(true);
    setExportStatus(null);
    try {
      const ranges = await buildPreviewRangesFromEngine();
      if (ranges.length === 0) {
        setExportStatus("Nothing to export — empty timeline.");
        return;
      }
      const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace(/-\d{3}Z$/, "Z"); // strip ms
      const outPath = `${folder.siftPath}/exports/sift-${stamp}.mp4`;
      // Export at the user-picked resolution.
      const result = await renderPreviewToFile(ranges, outPath, maxEdge);
      setExportStatus(`Exported to ${result.output_path}`);
    } catch (e) {
      setExportStatus(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(false);
    }
  }, [folder, exporting, maxEdge]);

  const [fcpxmlExporting, setFcpxmlExporting] = useState(false);
  const onExportFcpxml = useCallback(async () => {
    if (!folder || !activeVideoPath || fcpxmlExporting) return;
    setFcpxmlExporting(true);
    setExportStatus(null);
    try {
      const ranges = await project.renderRanges();
      if (ranges === null || ranges.ranges.length === 0) {
        setExportStatus("Nothing to export — empty timeline.");
        return;
      }
      // Probe the source MP4 for its real duration via a hidden
      // <video> element so the FCPXML asset length matches reality.
      // Frame rate isn't exposed by HTMLVideoElement, so we default
      // to 30fps and tell the user in a TODO; users can change it
      // in their NLE if the source is 24/25/29.97/60.
      const probe = await probeVideoMeta(activeVideoPath);
      const xml = buildFcpxml({
        sourcePath: activeVideoPath,
        sourceDurationSecs: probe.durationSecs,
        frameRate: probe.frameRate,
        width: probe.width,
        height: probe.height,
        ranges: rangesFromRenderResult(ranges.ranges),
        projectName: `Sift — ${basenameLite(activeVideoPath)}`,
      });
      const { save: saveDialog } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace(/-\d{3}Z$/, "Z");
      const defaultPath = `${folder.siftPath}/exports/sift-${stamp}.fcpxml`;
      const out = await saveDialog({
        title: "Export FCPXML",
        defaultPath,
        filters: [{ name: "FCPXML", extensions: ["fcpxml", "xml"] }],
      });
      if (typeof out !== "string") return;
      await writeTextFile(out, xml);
      setExportStatus(`Exported FCPXML to ${out}`);
    } catch (e) {
      setExportStatus(
        `FCPXML export failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setFcpxmlExporting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, activeVideoPath, fcpxmlExporting]);

  const onClearChat = useCallback(() => {
    // Revoke all snippet Blob URLs we handed out — they keep the
    // rendered MP4 bytes alive in memory until revoked.
    for (const url of snippetBlobUrlsRef.current) URL.revokeObjectURL(url);
    snippetBlobUrlsRef.current.clear();
    proposedOpsRef.current.clear();
    setChatMessages([]);
  }, []);

  const editCount = project.head?.n_ops ?? 0;
  const playerStatus =
    editCount > 0 ? `${editCount} edit${editCount === 1 ? "" : "s"} applied` : "no edits yet";

  // What the Player tab actually points at.
  const playerSourcePath =
    playerMode === "cut" && cutPlayerPath !== null ? cutPlayerPath : activeVideoPath;
  const playerCaption =
    playerMode === "cut"
      ? `current cut · ${playerStatus}`
      : cutError
        ? `original · ${cutError}`
        : playerStatus;
  const persistenceLabel: Record<typeof persistenceStatus, string> = {
    idle: "",
    loading: "loading…",
    saving: "saving…",
    saved: "saved",
    error: "save failed",
  };

  const persistencePillClass =
    persistenceStatus === "saved"
      ? "badge is-success"
      : persistenceStatus === "error"
        ? "badge is-danger"
        : persistenceStatus === "saving" || persistenceStatus === "loading"
          ? "badge is-info"
          : "badge is-muted";

  return (
    <div className="sift-app">
      <TopBar
        info={project.info}
        head={project.head}
        error={project.error}
        folder={folder}
        aiHealth={aiHealth.health}
      />

      <div className="body-grid" style={{ gridTemplateColumns, position: "relative" }}>
        {layout.leftCollapsed ? (
          <aside className="collapsed-rail" aria-label="Folder pane (collapsed)">
            <button
              type="button"
              className="btn-rail"
              onClick={toggleLeftCollapse}
              title="Expand folder pane"
            >
              <ChevronRight size={14} strokeWidth={2} />
            </button>
            <span className="btn-rail-label">Folder</span>
          </aside>
        ) : (
          <FolderPane
            folder={folder}
            onFolderChange={setFolder}
            activeVideoPath={activeVideoPath}
            onActiveVideoChange={setActiveVideoPath}
            transcriptionStatus={transcriptionQueue.entries}
            aiHealth={aiHealth.health}
            onCollapse={toggleLeftCollapse}
          />
        )}

        {/* Drag gutter between folder pane and center. Only when expanded. */}
        {layout.leftCollapsed ? null : (
          <div
            className={`resize-gutter${dragRef.current?.side === "left" ? " is-dragging" : ""}`}
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: `${layout.leftWidth - 3}px`,
            }}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize folder pane"
            onPointerDown={onGutterPointerDown("left")}
            onPointerMove={onGutterPointerMove}
            onPointerUp={onGutterPointerUp}
            onPointerCancel={onGutterPointerUp}
          />
        )}

        {/* Center: Player | Transcript tabs */}
        <section className="panel center">
          <CenterTabs
            active={activeTab}
            onChange={setActiveTab}
            right={
              <>
                <span className="meta-text">{playerStatus}</span>
                {persistenceLabel[persistenceStatus] !== "" ? (
                  <span
                    className={persistencePillClass}
                    title={folder?.projectFilePath ?? ""}
                  >
                    {persistenceLabel[persistenceStatus]}
                  </span>
                ) : null}
                <select
                  className="select-inline"
                  value={maxEdge}
                  onChange={(e) => setMaxEdge(Number.parseInt(e.target.value, 10))}
                  title={
                    sourceResolution
                      ? `Source: ${sourceResolution.w}×${sourceResolution.h} — Render at:`
                      : "Render resolution (long edge)"
                  }
                >
                  {RESOLUTION_TIERS.map((tier) => (
                    <option key={tier.maxEdge} value={tier.maxEdge}>
                      {tier.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn is-tertiary is-sm"
                  onClick={() => void project.undo()}
                  disabled={!project.canUndo}
                  title="Undo (⌘Z)"
                >
                  <Undo2 size={12} strokeWidth={2} />
                  Undo
                </button>
                {playerMode === "cut" ? (
                  <button
                    type="button"
                    className="btn is-secondary is-sm"
                    onClick={onShowOriginal}
                    title="Switch the player back to the original source"
                  >
                    <Video size={12} strokeWidth={2} />
                    Show original
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn is-secondary is-sm"
                    onClick={() => void onPlayCurrentCut()}
                    disabled={
                      !activeVideoPath || !folder || cutRendering || editCount === 0
                    }
                    title={
                      editCount === 0
                        ? "Make an edit first — the original plays by default"
                        : "Render the full cut and play it in this tab"
                    }
                  >
                    {cutRendering ? (
                      <Loader2 size={12} strokeWidth={2} className="spin" />
                    ) : (
                      <Play size={12} strokeWidth={2} />
                    )}
                    {cutRendering ? "Rendering…" : "Play cut"}
                  </button>
                )}
                <button
                  type="button"
                  className="btn is-tertiary is-sm"
                  onClick={() => void onExportFcpxml()}
                  disabled={!folder || !activeVideoPath || fcpxmlExporting || editCount === 0}
                  title={
                    editCount === 0
                      ? "Make an edit first — there's nothing to export"
                      : "Export an FCPXML hand-off for Final Cut Pro / DaVinci Resolve / Premiere"
                  }
                >
                  {fcpxmlExporting ? (
                    <Loader2 size={12} strokeWidth={2} className="spin" />
                  ) : (
                    <FileCode2 size={12} strokeWidth={2} />
                  )}
                  {fcpxmlExporting ? "Exporting…" : "FCPXML"}
                </button>
                <button
                  type="button"
                  className="btn is-primary is-sm"
                  onClick={() => void onExportCut()}
                  disabled={!folder || exporting || editCount === 0}
                  title={
                    editCount === 0
                      ? "Make an edit first — there's nothing to export"
                      : (exportStatus ?? "Render the full-res cut to .sift/exports/")
                  }
                >
                  {exporting ? (
                    <Loader2 size={12} strokeWidth={2} className="spin" />
                  ) : (
                    <Download size={12} strokeWidth={2} />
                  )}
                  {exporting ? "Exporting…" : "Export"}
                </button>
              </>
            }
          />
          {/*
            Both center components stay mounted so their state — most
            importantly the transcript pane's in-flight Whisper request
            — survives tab switches. Inactive tab is `display: none`,
            which pauses any media but preserves component state.
          */}
          <div
            style={{
              position: "relative",
              flex: "1 1 auto",
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: activeTab === "player" ? "flex" : "none",
                flexDirection: "column",
              }}
            >
              <VideoPlayer
                sourcePath={playerSourcePath}
                statusCaption={playerCaption}
                cutMode={playerMode === "cut"}
                editCount={editCount}
                onResolutionDetected={onResolutionDetected}
                active={activeTab === "player"}
              />
            </div>
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: activeTab === "transcript" ? "flex" : "none",
                flexDirection: "column",
              }}
            >
              <TranscriptEditorPane
                ref={transcriptRef}
                project={project}
                bootstrapMediaPath={bootstrapTranscribePath}
                onBootstrapConsumed={() => setBootstrapTranscribePath(null)}
                whisperModel={whisperModel}
                onWhisperModelChange={onWhisperModelChange}
                siftPath={folder?.siftPath ?? null}
              />
            </div>
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: activeTab === "cutlist" ? "flex" : "none",
                flexDirection: "column",
              }}
            >
              <CutListPane
                ranges={cutListRanges}
                transcript={cutListTranscript}
                hasVideo={activeVideoPath !== null}
              />
            </div>
          </div>
        </section>

        {/* Drag gutter between center and chat. Only when chat expanded. */}
        {layout.rightCollapsed ? null : (
          <div
            className={`resize-gutter${dragRef.current?.side === "right" ? " is-dragging" : ""}`}
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              right: `${layout.rightWidth - 3}px`,
            }}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize chat pane"
            onPointerDown={onGutterPointerDown("right")}
            onPointerMove={onGutterPointerMove}
            onPointerUp={onGutterPointerUp}
            onPointerCancel={onGutterPointerUp}
          />
        )}

        {layout.rightCollapsed ? (
          <aside className="collapsed-rail is-right" aria-label="Chat pane (collapsed)">
            <button
              type="button"
              className="btn-rail"
              onClick={toggleRightCollapse}
              title="Expand chat pane"
            >
              <ChevronLeft size={14} strokeWidth={2} />
            </button>
            <span className="btn-rail-label">Chat</span>
          </aside>
        ) : (
          <ChatPanel
            messages={chatMessages}
            busy={chatBusy}
            onSubmit={onChatSubmit}
            onApprove={onChatApprove}
            onUndo={onChatUndo}
            onOpenInPlayer={onOpenSnippetInPlayer}
            onClearChat={onClearChat}
            onCollapse={toggleRightCollapse}
            disabled={!folder || !activeVideoPath}
            disabledReason={
              !folder
                ? "Open a folder to start chatting."
                : !activeVideoPath
                  ? "Pick a video in the folder pane to start."
                  : undefined
            }
          />
        )}
      </div>

      {onboardingOpen ? <FirstRunOverlay onDismiss={dismissOnboarding} /> : null}
    </div>
  );
}
