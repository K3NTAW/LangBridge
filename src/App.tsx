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
import { FirstRunOverlay } from "./components/FirstRunOverlay";
import { dismissOnboardingPersist, readOnboardingDismissed } from "./lib/onboardingStorage";
import { useEngineProject } from "./lib/useEngineProject";
import { loadStoredWhisperModel, saveStoredWhisperModel } from "./lib/whisperModels";
import { ulidLite } from "./lib/ulid";
import type { FolderProject } from "./lib/folderProject";
import { ensureProjectsDir, getVideoProjectPath } from "./lib/perVideoProject";
import { planFromHandle } from "./lib/stubPlanner";
import type { TranscriptHandle } from "./lib/transcriptOps";
import type { Op } from "./lib/ops";
import { computeSnippetRangesAfterDeletes } from "./lib/previewSnippet";
import {
  buildPreviewRangesFromEngine,
  previewFileToBlobUrl,
  renderPreviewToFile,
  type PreviewRenderRange,
} from "./lib/previewRender";
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
  // Ops attached to assistant messages, keyed by message id. Lifted
  // out of ChatMessage so we don't have to serialise BigInt-ish ops
  // through React state diffing.
  const proposedOpsRef = useRef<Map<string, Op[]>>(new Map());

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

  // Keyboard shortcuts: tab switching + undo/redo. Project lifecycle
  // hotkeys (⌘N/⌘O/⌘S) are deferred until folder-based persistence
  // lands; the user opens folders via the FolderPane button.
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
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) void project.redo();
        else void project.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        void project.redo();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [project]);

  // M-A stub planner: deterministic intent matching against the
  // current transcript. Real Claude tool-use replaces this in M-B
  // with no change to the ChatPanel surface.
  const onChatSubmit = useCallback(
    async (text: string) => {
      const userMsg: ChatMessage = {
        id: ulidLite(),
        role: "user",
        body: text,
        createdAt: Date.now(),
      };
      setChatMessages((prev) => [...prev, userMsg]);
      setChatBusy(true);
      // Tiny artificial delay so the "thinking…" pill shows.
      await new Promise((r) => setTimeout(r, 200));

      const proposal = planFromHandle(text, transcriptRef.current);
      const msgId = ulidLite();
      const artifactId = `${msgId}-a`;
      if (proposal.actionable && proposal.ops.length > 0) {
        proposedOpsRef.current.set(msgId, proposal.ops);
      }
      const transcriptState = transcriptRef.current?.getState() ?? null;
      const sourcePath =
        transcriptState?.sourcePath ?? activeVideoPath ?? null;
      const canRenderSnippet =
        proposal.actionable
        && transcriptState !== null
        && sourcePath !== null
        && proposal.deletedWordIndices.length > 0
        && folder !== null;

      const aiMsg: ChatMessage = {
        id: msgId,
        role: "assistant",
        body: proposal.body,
        ...(proposal.question === undefined ? {} : { question: proposal.question }),
        createdAt: Date.now(),
        artifacts: proposal.actionable
          ? [
              {
                id: artifactId,
                caption: `Proposed edit · ${proposal.ops.length} op${proposal.ops.length === 1 ? "" : "s"}`,
                blobUrl: null,
                rendering: canRenderSnippet,
                error: null,
              },
            ]
          : [],
      };
      setChatMessages((prev) => [...prev, aiMsg]);
      setChatBusy(false);

      // Kick off the snippet render in the background. The message
      // already exists in chat with `rendering: true`; we patch in the
      // Blob URL (or an error) when FFmpeg finishes.
      if (canRenderSnippet && transcriptState !== null && sourcePath !== null && folder !== null) {
        void (async () => {
          try {
            const ranges: PreviewRenderRange[] = computeSnippetRangesAfterDeletes(
              transcriptState,
              proposal.deletedWordIndices,
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
            // Snippet previews are always lightweight — cap at 720p
            // regardless of the user's render-resolution preference so
            // chat artifacts stay snappy. Full quality kicks in for
            // "Play cut" and Export below.
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
    [activeVideoPath, folder],
  );

  const onChatApprove = useCallback(
    async (id: string) => {
      const ops = proposedOpsRef.current.get(id);
      if (!ops || ops.length === 0) return;
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
