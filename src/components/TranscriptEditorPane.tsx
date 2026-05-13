/**
 * Transcript editor — wedge UI, **engine-backed**.
 *
 * Flow:
 *   1. Pick a video (Tauri file dialog), **or** bootstrap from Media Pool **Transcribe…**
 *      (same Whisper + ingest pipeline).
 *   2. sift-ai runs Whisper, returns word-level timestamps.
 *   3. Each word is ingested into the engine as a one-clip span on a
 *      single video track (timeline slots packed head-to-tail so Whisper’s
 *      overlapping timings don’t trip clip-overlap validation). Source +
 *      Track + N×ClipInsert is sent in
 *      one `apply_batch`. After ingest we `clear_history` so the
 *      user's first Cmd-Z lands on the first edit, not on the import.
 *   4. Optional **auto-clean**: filler sounds (`transcriptCleanup`) are
 *      removed in one `apply_batch` with `group_undo` so **one ⌘Z**
 *      restores every auto-deleted word.
 *   5. Click a word → engine `apply(ClipDelete)`. Undo/redo work via
 *      the engine ops log (Cmd-Z / Cmd-Shift-Z).
 *   6. Export → `engine.renderRanges()` → sift-ai recut from those
 *      ranges. The engine is the source of truth for what's in the
 *      cut.
 *
 * State sync:
 *
 * The component holds the transcript and the `wordIndex ↔ clipId`
 * mapping locally. The "which words are currently deleted" derived
 * state is **recomputed from the engine's render plan** after every
 * change to `project.head` — so undo/redo invoked from anywhere in
 * the app (App-level Cmd-Z, future buttons, AI plan-edits) propagates
 * to the transcript view without needing the trigger source to also
 * call back into us.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertCircle,
  Captions,
  Download,
  Eraser,
  FileVideo,
  GitCompare,
  Loader2,
  Mic,
  MousePointerClick,
  Redo2,
  RotateCcw,
  ScrollText,
  Sparkles,
  Undo2,
  VolumeX,
} from "lucide-react";

import {
  AIServiceError,
  getAIClient,
  type DiarizationRequestMode,
  type RecutRange,
  type Transcript,
} from "../lib/aiClient";
import {
  CAPTION_STYLE_PRESETS,
  EXPORT_VIDEO_PRESET_LABELS,
  type CaptionSidecarFormat,
  type CaptionStylePresetId,
  type ExportVideoPresetId,
  scaleMaxHeightForPreset,
} from "../lib/captionPresets";
import {
  buildCaptionsSrtFromWords,
  buildCaptionsVttFromWords,
  suggestCaptionsPath,
  suggestCaptionsVttPath,
} from "../lib/captionsSrt";
import { renderRangesToRecutRanges } from "../lib/exportRecut";
import type { UseEngineProject } from "../lib/useEngineProject";
import type { ClipId, Op, SourceId, TrackId } from "../lib/ops";
import { asId } from "../lib/ops";
import {
  clipSecondsFromTicks,
  formatParenTimestamp,
  layoutTranscriptWords,
  whisperChipLabel,
} from "../lib/transcriptDisplay";
import { buildIngestOps, reconcileDeleted } from "../lib/transcriptIngest";
import {
  buildFillerDeleteOps as buildFillerDeleteOpsShared,
  buildWordIndexDeleteOps as buildWordIndexDeleteOpsShared,
  type IngestResult as SharedIngestResult,
  type TranscriptHandle,
  type TranscriptState,
} from "../lib/transcriptOps";
import { readCachedTranscript, writeCachedTranscript } from "../lib/transcriptCache";
import { WHISPER_MODEL_OPTIONS } from "../lib/whisperModels";
import { cn } from "../lib/cn";
import { modKeySymbol } from "../lib/modKey";
import { Kbd } from "./ui/Kbd";
import { TranscriptRemovalDiff } from "./TranscriptRemovalDiff";

interface Props {
  project: UseEngineProject;
  /** From Media Pool "Transcribe…": auto-run Whisper + word ingest once path is set. */
  bootstrapMediaPath?: string | null;
  onBootstrapConsumed?: () => void;
  /** Whisper model id, or "" until the user selects one (onboarding). */
  whisperModel: string;
  onWhisperModelChange: (modelId: string) => void;
  /**
   * Path to the current folder's hidden `.sift/` directory, or null
   * when running standalone (no folder open). Enables transcript
   * caching: lookups read `<siftPath>/transcripts/...json` before
   * hitting Whisper; successful runs write the same path back.
   */
  siftPath?: string | null;
}

type Status =
  | { kind: "idle" }
  | { kind: "transcribing"; mediaPath: string }
  | { kind: "ingesting"; mediaPath: string; transcript: Transcript }
  | { kind: "ready"; mediaPath: string; transcript: Transcript }
  | { kind: "exporting"; mediaPath: string; transcript: Transcript }
  | { kind: "error"; message: string; previous?: Status };

interface ExportSummary {
  outputPath: string;
  sizeBytes: number;
  nRanges: number;
}

// IngestResult moved to lib/transcriptOps.ts so the chat planner can reuse it.
type IngestResult = SharedIngestResult;

/**
 * State of the most recent auto-clean pass.
 *
 * Persists until the engine head moves off `afterHead` — meaning the
 * user did anything (manual delete, undo, redo, AI plan-edit). The
 * "Undo auto-clean" affordance is only safe while the head matches;
 * once it moves, undoing N times might unwind manual edits the user
 * intended to keep.
 */
interface AutoCleanState {
  /** How many filler clip-deletes the batch applied. */
  count: number;
  /** Engine head op-id immediately after the batch landed. */
  afterHead: string | null;
  /** Word indices that were deleted, so we can refresh the optimistic set. */
  wordIndices: number[];
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i === -1 ? p : p.substring(i + 1);
}

/** Thin local adapter so existing call sites keep their signature. */
function buildFillerDeleteOps(
  transcript: Transcript,
  ingest: IngestResult,
): { ops: Op[]; wordIndices: number[] } {
  return buildFillerDeleteOpsShared({ transcript, ingest, deleted: new Set() });
}

function buildWordIndexDeleteOps(
  transcript: Transcript,
  ingest: IngestResult,
  indices: readonly number[],
): { ops: Op[]; wordIndices: number[] } {
  return buildWordIndexDeleteOpsShared(
    { transcript, ingest, deleted: new Set() },
    indices,
  );
}

function suggestOutputPath(input: string): string {
  const dot = input.lastIndexOf(".");
  if (dot === -1) return `${input}.cut.mp4`;
  return `${input.substring(0, dot)}.cut${input.substring(dot)}`;
}

export const TranscriptEditorPane = forwardRef<TranscriptHandle, Props>(function TranscriptEditorPane(
  {
    project,
    bootstrapMediaPath = null,
    onBootstrapConsumed,
    whisperModel,
    onWhisperModelChange,
    siftPath = null,
  },
  ref,
) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [ingest, setIngest] = useState<IngestResult | null>(null);
  const [deleted, setDeleted] = useState<ReadonlySet<number>>(new Set());
  const [exportSummary, setExportSummary] = useState<ExportSummary | null>(null);
  const [autoClean, setAutoClean] = useState<AutoCleanState | null>(null);
  const [captionNotice, setCaptionNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [removalDiffOpen, setRemovalDiffOpen] = useState(false);
  const [exportVideoPreset, setExportVideoPreset] = useState<ExportVideoPresetId>("height_1080");
  const [captionStylePreset, setCaptionStylePreset] = useState<CaptionStylePresetId>("clean");
  const [captionSidecarFormat, setCaptionSidecarFormat] = useState<CaptionSidecarFormat>("srt");
  const [burnInCaptions, setBurnInCaptions] = useState(false);
  const [enrichBusy, setEnrichBusy] = useState(false);
  const [enrichNotice, setEnrichNotice] = useState<string | null>(null);
  const [silenceStrip, setSilenceStrip] = useState<AutoCleanState | null>(null);
  const [silenceStripBusy, setSilenceStripBusy] = useState(false);
  const [sceneThreshold, setSceneThreshold] = useState(0.34);
  const [speakerGapSeconds, setSpeakerGapSeconds] = useState(1.25);
  const [diarizationMode, setDiarizationMode] = useState<DiarizationRequestMode>("auto");
  const [silenceNoiseDb, setSilenceNoiseDb] = useState(-40);
  const [silenceMinDuration, setSilenceMinDuration] = useState(0.45);
  const [silenceOverlap, setSilenceOverlap] = useState(0.55);

  const transcript = (
    status.kind === "ready"
    || status.kind === "exporting"
    || status.kind === "ingesting"
  )
    ? status.transcript
    : null;

  const mediaPath = (
    status.kind === "transcribing"
    || status.kind === "ready"
    || status.kind === "exporting"
    || status.kind === "ingesting"
  )
    ? status.mediaPath
    : null;

  // Expose the transcript + ingest + deleted state to the chat planner
  // via ref. The handle's getState() snapshots the current values
  // each call so the planner always reads fresh data.
  useImperativeHandle(
    ref,
    () => ({
      hasTranscript(): boolean {
        return transcript !== null && ingest !== null;
      },
      getState(): TranscriptState | null {
        if (transcript === null || ingest === null) return null;
        const state: TranscriptState = { transcript, ingest, deleted };
        if (mediaPath !== null) state.sourcePath = mediaPath;
        return state;
      },
    }),
    [transcript, ingest, deleted, mediaPath],
  );

  const keptWordCount = useMemo(() => {
    if (transcript === null) return 0;
    return transcript.words.length - deleted.size;
  }, [transcript, deleted]);

  const autoCleanRemovedWordsTitle = useMemo(() => {
    if (autoClean === null || transcript === null) return "";
    return autoClean.wordIndices
      .map((i) => transcript.words[i]?.word?.trim() ?? "")
      .filter(Boolean)
      .join(", ");
  }, [autoClean, transcript]);

  const autoCleanRemovedWordsPreview = useMemo(() => {
    if (autoClean === null || transcript === null || autoClean.wordIndices.length === 0) {
      return null;
    }
    const maxWords = 10;
    const slice = autoClean.wordIndices.slice(0, maxWords);
    const parts = slice.map((i) => transcript.words[i]?.word?.trim() ?? "").filter(Boolean);
    if (parts.length === 0) return null;
    const more = autoClean.wordIndices.length - maxWords;
    let line = parts.join(", ");
    if (more > 0) line += ` (+${more} more)`;
    return line;
  }, [autoClean, transcript]);

  const silenceStripRemovedWordsTitle = useMemo(() => {
    if (silenceStrip === null || transcript === null) return "";
    return silenceStrip.wordIndices
      .map((i) => transcript.words[i]?.word?.trim() ?? "")
      .filter(Boolean)
      .join(", ");
  }, [silenceStrip, transcript]);

  const silenceStripRemovedWordsPreview = useMemo(() => {
    if (silenceStrip === null || transcript === null || silenceStrip.wordIndices.length === 0) {
      return null;
    }
    const maxWords = 10;
    const slice = silenceStrip.wordIndices.slice(0, maxWords);
    const parts = slice.map((i) => transcript.words[i]?.word?.trim() ?? "").filter(Boolean);
    if (parts.length === 0) return null;
    const more = silenceStrip.wordIndices.length - maxWords;
    let line = parts.join(", ");
    if (more > 0) line += ` (+${more} more)`;
    return line;
  }, [silenceStrip, transcript]);

  const lastReconciledHead = useRef<string | null | undefined>(undefined);
  const transcribeLockRef = useRef(false);
  const bootstrapHandledRef = useRef<string | null>(null);

  // After every engine head change, recompute the deleted set from
  // the engine's render plan. This is the synchronization point that
  // makes the UI converge to engine state regardless of where an
  // undo/redo/apply was triggered.
  useEffect(() => {
    if (transcript === null || ingest === null) return;
    const headValue = project.head?.head ?? null;
    if (lastReconciledHead.current === headValue) return;
    lastReconciledHead.current = headValue;
    void (async () => {
      const r = await project.renderRanges();
      if (r === null) return;
      setDeleted(reconcileDeleted(transcript.words, r.ranges));
    })();
  }, [project, transcript, ingest]);

  // Clear the auto-clean banner the moment the user does anything
  // else — manual delete, undo, redo, future AI plan-edit. Once the
  // head moves, the "Undo auto-clean" button no longer maps cleanly
  // to "back to the post-ingest state" and we'd rather hide the
  // affordance than do something subtly wrong.
  useEffect(() => {
    if (autoClean === null) return;
    const headValue = project.head?.head ?? null;
    if (headValue !== autoClean.afterHead) {
      setAutoClean(null);
    }
  }, [project.head, autoClean]);

  useEffect(() => {
    if (silenceStrip === null) return;
    const headValue = project.head?.head ?? null;
    if (headValue !== silenceStrip.afterHead) {
      setSilenceStrip(null);
    }
  }, [project.head, silenceStrip]);

  const onWhisperModelSelect = useCallback(
    (e: ChangeEvent<HTMLSelectElement>) => {
      onWhisperModelChange(e.target.value);
    },
    [onWhisperModelChange],
  );

  const runTranscribePipeline = useCallback(
    async (picked: string) => {
      if (!whisperModel.trim()) {
        setStatus({
          kind: "error",
          message: "Choose a Whisper model from the dropdown before transcribing.",
        });
        return;
      }
      if (transcribeLockRef.current) return;
      transcribeLockRef.current = true;
      try {
        setExportSummary(null);
        setDeleted(new Set());
        setIngest(null);
        setAutoClean(null);
        setSilenceStrip(null);
        setStatus({ kind: "transcribing", mediaPath: picked });

        let transcriptResult: Transcript | null = null;
        // Try the on-disk cache first — keyed by (path, whisper model,
        // size, mtime). Avoids re-running Whisper on every app restart.
        if (siftPath) {
          try {
            transcriptResult = await readCachedTranscript(
              siftPath,
              picked,
              whisperModel,
            );
          } catch {
            // Cache lookup failures are non-fatal; fall through to Whisper.
            transcriptResult = null;
          }
        }
        if (transcriptResult === null) {
          try {
            transcriptResult = await getAIClient().transcribe(picked, "local", {
              whisper_model: whisperModel,
            });
          } catch (e) {
            const msg =
              e instanceof AIServiceError
                ? e.detail
                : e instanceof Error
                  ? e.message
                  : String(e);
            setStatus({ kind: "error", message: `Transcribe failed: ${msg}` });
            return;
          }
          // Persist for next time. Failure here is non-fatal.
          if (siftPath) {
            const tr: Transcript = transcriptResult;
            void writeCachedTranscript(siftPath, picked, whisperModel, tr).catch(() => {});
          }
        }

        setStatus({ kind: "ingesting", mediaPath: picked, transcript: transcriptResult });

        await project.newProject();

        const { ops, wordToClipId } = buildIngestOps(picked, transcriptResult.words);
        const batchOutcome = await project.applyBatch(ops);
        if (!batchOutcome.ok) {
          setStatus({
            kind: "error",
            message: `Ingest failed: ${batchOutcome.error}`,
          });
          return;
        }
        await project.clearHistory();
        setIngest({ wordToClipId });
        lastReconciledHead.current = null;
        setDeleted(new Set());

        const ingestSnapshot: IngestResult = { wordToClipId };
        const { ops: fillerOps, wordIndices } = buildFillerDeleteOps(transcriptResult, ingestSnapshot);
        if (fillerOps.length > 0) {
          const frOutcome = await project.applyBatch(fillerOps, { group_undo: true });
          if (!frOutcome.ok) {
            setStatus({
              kind: "error",
              message: `Filler auto-clean failed: ${frOutcome.error}`,
            });
            return;
          }
          setAutoClean({
            count: fillerOps.length,
            afterHead: frOutcome.result.head ?? null,
            wordIndices,
          });
        } else {
          setAutoClean(null);
          setSilenceStrip(null);
        }

        setStatus({ kind: "ready", mediaPath: picked, transcript: transcriptResult });
      } finally {
        transcribeLockRef.current = false;
      }
    },
    [project, whisperModel, siftPath],
  );

  useEffect(() => {
    if (!bootstrapMediaPath) {
      bootstrapHandledRef.current = null;
      return;
    }
    if (!whisperModel.trim()) return;
    if (bootstrapHandledRef.current === bootstrapMediaPath) return;
    bootstrapHandledRef.current = bootstrapMediaPath;
    onBootstrapConsumed?.();
    void runTranscribePipeline(bootstrapMediaPath);
  }, [bootstrapMediaPath, onBootstrapConsumed, runTranscribePipeline, whisperModel]);

  const onPickVideo = useCallback(async () => {
    const picked = await openDialog({
      multiple: false,
      directory: false,
      title: "Pick a video to transcribe",
      filters: [
        { name: "Video", extensions: ["mp4", "mov", "m4v", "mkv", "webm", "avi"] },
        { name: "Audio", extensions: ["wav", "mp3", "m4a", "aac", "flac", "ogg"] },
        { name: "Any", extensions: ["*"] },
      ],
    });
    if (typeof picked !== "string") return;
    await runTranscribePipeline(picked);
  }, [runTranscribePipeline]);

  const onToggleWord = useCallback(
    async (idx: number) => {
      if (transcript === null || ingest === null) return;
      const isCurrentlyDeleted = deleted.has(idx);
      const clipId = ingest.wordToClipId.get(idx);
      if (clipId === undefined) return; // zero-duration word never ingested
      const w = transcript.words[idx];
      if (w === undefined) return;

      if (!isCurrentlyDeleted) {
        // User wants to delete it.
        const op: Op = {
          kind: "clip_delete",
          clip_id: asId<"ClipId">(clipId) as ClipId,
          ripple: false,
        };
        const r = await project.apply(op);
        if (r === null) return;
        // The reconcile effect will re-derive `deleted` from the new
        // head. Update optimistically too so the click feels instant.
        setDeleted((prev) => {
          const next = new Set(prev);
          next.add(idx);
          return next;
        });
      } else {
        // User wants to undelete by re-inserting the same clip.
        const trackResult = await project.renderRanges();
        if (trackResult === null) return;
        const trackId = trackResult.track_id;
        if (trackId === null) return;
        const op: Op = {
          kind: "clip_insert",
          clip_id: asId<"ClipId">(clipId) as ClipId,
          track_id: asId<"TrackId">(trackId) as TrackId,
          source_id: asId<"SourceId">(trackResult.ranges[0]?.source_id ?? "") as SourceId,
          src_in: BigInt(w.start_ticks),
          src_out: BigInt(w.end_ticks),
          timeline_at: BigInt(w.start_ticks),
        };
        const r = await project.apply(op);
        if (r === null) return;
        setDeleted((prev) => {
          const next = new Set(prev);
          next.delete(idx);
          return next;
        });
      }
    },
    [project, transcript, ingest, deleted],
  );

  const onClearDeletions = useCallback(async () => {
    // "Restore N deleted" is a single-undo-step gesture: walk the engine's
    // undo stack until everything's back. Cleaner than fabricating N
    // ClipInserts because it preserves the natural undo semantics.
    while (project.head?.can_undo) {
      const r = await project.undo();
      if (r === null) break;
    }
  }, [project]);

  const onExport = useCallback(async () => {
    if (transcript === null || mediaPath === null) return;
    const ranges = await project.renderRanges();
    if (ranges === null || ranges.ranges.length === 0) return;
    const out = await saveDialog({
      title: "Export recut video",
      defaultPath: suggestOutputPath(mediaPath),
      filters: [{ name: "MP4", extensions: ["mp4"] }],
    });
    if (typeof out !== "string") return;

    const captionOpts = CAPTION_STYLE_PRESETS[captionStylePreset].options;
    const burnStyle = CAPTION_STYLE_PRESETS[captionStylePreset].burnInForceStyle;
    const scaleMax = scaleMaxHeightForPreset(exportVideoPreset);

    let burnPath: string | null = null;
    if (burnInCaptions) {
      const sidecar = buildCaptionsSrtFromWords(
        transcript.words,
        deleted,
        captionOpts,
        ranges.ranges,
      );
      if (!sidecar.trim()) {
        setCaptionNotice({
          kind: "err",
          text: "Burn-in needs at least one kept timed word — adjust the cut.",
        });
        return;
      }
      burnPath = `${out}.cut-burn-in.srt`;
      try {
        const { writeTextFile } = await import("@tauri-apps/plugin-fs");
        await writeTextFile(burnPath, sidecar);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setCaptionNotice({ kind: "err", text: `Could not write burn-in subtitle file: ${msg}` });
        return;
      }
    }

    setStatus({ kind: "exporting", mediaPath, transcript });
    try {
      const recutRanges: RecutRange[] = renderRangesToRecutRanges(ranges.ranges);
      const result = await getAIClient().recut(mediaPath, out, recutRanges, {
        preset: "medium",
        crf: 20,
        scale_max_height: scaleMax,
        subtitle_path: burnPath,
        subtitle_force_style: burnInCaptions ? burnStyle : null,
      });
      setExportSummary({
        outputPath: result.output_path,
        sizeBytes: result.size_bytes,
        nRanges: result.n_ranges,
      });
      setStatus({ kind: "ready", mediaPath, transcript });
      if (burnPath !== null) {
        try {
          const { remove } = await import("@tauri-apps/plugin-fs");
          await remove(burnPath);
        } catch {
          /* temp sidecar may remain; harmless */
        }
      }
    } catch (e) {
      const msg = e instanceof AIServiceError
        ? e.detail
        : e instanceof Error
        ? e.message
        : String(e);
      setStatus({
        kind: "error",
        message: `Export failed: ${msg}`,
        previous: { kind: "ready", mediaPath, transcript },
      });
      if (burnPath !== null) {
        try {
          const { remove } = await import("@tauri-apps/plugin-fs");
          await remove(burnPath);
        } catch {
          /* ignore */
        }
      }
    }
  }, [
    project,
    transcript,
    mediaPath,
    deleted,
    burnInCaptions,
    captionStylePreset,
    exportVideoPreset,
  ]);

  useEffect(() => {
    if (captionNotice === null) return;
    const ms = captionNotice.kind === "ok" ? 4500 : 8000;
    const t = window.setTimeout(() => setCaptionNotice(null), ms);
    return () => window.clearTimeout(t);
  }, [captionNotice]);

  const onExportCaptions = useCallback(async () => {
    if (transcript === null || mediaPath === null) return;
    const rr = await project.renderRanges();
    if (rr === null || rr.ranges.length === 0) {
      setCaptionNotice({
        kind: "err",
        text: "No kept ranges from the engine — restore words or reload the project.",
      });
      return;
    }
    const capOpts = CAPTION_STYLE_PRESETS[captionStylePreset].options;
    const body =
      captionSidecarFormat === "vtt"
        ? buildCaptionsVttFromWords(transcript.words, deleted, capOpts, rr.ranges)
        : buildCaptionsSrtFromWords(transcript.words, deleted, capOpts, rr.ranges);
    if (!body.trim()) {
      setCaptionNotice({
        kind: "err",
        text: "No kept words with timings — remove fewer words or re-transcribe.",
      });
      return;
    }
    const defaultPath =
      captionSidecarFormat === "vtt" ? suggestCaptionsVttPath(mediaPath) : suggestCaptionsPath(mediaPath);
    const out = await saveDialog({
      title: captionSidecarFormat === "vtt" ? "Export captions (WebVTT)" : "Export captions (SubRip)",
      defaultPath,
      filters:
        captionSidecarFormat === "vtt"
          ? [{ name: "WebVTT", extensions: ["vtt"] }]
          : [{ name: "SubRip", extensions: ["srt"] }],
    });
    if (typeof out !== "string") return;
    try {
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(out, body);
      setCaptionNotice({ kind: "ok", text: basename(out) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setCaptionNotice({ kind: "err", text: msg });
    }
  }, [transcript, mediaPath, deleted, project, captionSidecarFormat, captionStylePreset]);

  const onPostprocessEnrich = useCallback(async () => {
    if (transcript === null || mediaPath === null) return;
    setEnrichBusy(true);
    setEnrichNotice(null);
    try {
      const r = await getAIClient().postprocess(mediaPath, transcript, {
        scene_threshold: sceneThreshold,
        speaker_gap_seconds: speakerGapSeconds,
        diarization: diarizationMode,
      });
      setStatus((prev) => {
        if (prev.kind !== "ready") return prev;
        return { ...prev, transcript: r.transcript };
      });
      const nScenes = r.scene_cut_ticks.length;
      const src = r.scene_detection === "ffmpeg" ? "FFmpeg scene filter" : "unavailable (skipped)";
      const diLabel =
        r.diarization_method === "pyannote" ? "Pyannote diarization" : "Gap speaker hints";
      setEnrichNotice(`${diLabel} · ${nScenes} scene cuts (${src}).`);
    } catch (e) {
      const msg = e instanceof AIServiceError ? e.detail : e instanceof Error ? e.message : String(e);
      setEnrichNotice(`Analyze failed: ${msg}`);
    } finally {
      setEnrichBusy(false);
    }
  }, [transcript, mediaPath, sceneThreshold, speakerGapSeconds, diarizationMode]);

  useEffect(() => {
    if (enrichNotice === null) return;
    const t = window.setTimeout(() => setEnrichNotice(null), 10000);
    return () => window.clearTimeout(t);
  }, [enrichNotice]);

  const onDismissError = useCallback(() => {
    setStatus((s) => (s.kind === "error" && s.previous ? s.previous : { kind: "idle" }));
  }, []);

  const onAutoCleanFillers = useCallback(async () => {
    if (transcript === null || ingest === null) return;
    const { ops, wordIndices } = buildFillerDeleteOps(transcript, ingest);
    if (ops.length === 0) return;
    const fr = await project.applyBatch(ops, { group_undo: true });
    if (!fr.ok) return;
    setAutoClean({
      count: ops.length,
      afterHead: fr.result.head ?? null,
      wordIndices,
    });
  }, [project, transcript, ingest]);

  const onUndoAutoClean = useCallback(async () => {
    await project.undo();
  }, [project]);

  const onAutoCleanSilence = useCallback(async () => {
    if (transcript === null || ingest === null || mediaPath === null) return;
    setSilenceStripBusy(true);
    try {
      const r = await getAIClient().silentWords(mediaPath, transcript, {
        noise_db: silenceNoiseDb,
        min_duration_s: silenceMinDuration,
        overlap_ratio: silenceOverlap,
      });
      const { ops, wordIndices } = buildWordIndexDeleteOps(transcript, ingest, r.word_indices);
      if (ops.length === 0) {
        setEnrichNotice("Strip silence: no words matched dead-air detection.");
        return;
      }
      const fr = await project.applyBatch(ops, { group_undo: true });
      if (!fr.ok) return;
      setSilenceStrip({
        count: ops.length,
        afterHead: fr.result.head ?? null,
        wordIndices,
      });
    } catch (e) {
      const msg = e instanceof AIServiceError ? e.detail : e instanceof Error ? e.message : String(e);
      setEnrichNotice(`Strip silence failed: ${msg}`);
    } finally {
      setSilenceStripBusy(false);
    }
  }, [transcript, ingest, mediaPath, project, silenceNoiseDb, silenceMinDuration, silenceOverlap]);

  const onUndoSilenceStrip = useCallback(async () => {
    await project.undo();
  }, [project]);

  const isBusy = status.kind === "transcribing"
    || status.kind === "ingesting"
    || status.kind === "exporting";

  const mod = modKeySymbol();

  return (
    <div className="flex h-full flex-col bg-[var(--cut-bg-deep)]">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-zinc-800/80 bg-[var(--cut-bg-panel)] px-3">
        <div className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-zinc-200">
          <ScrollText className="h-4 w-4 shrink-0 text-zinc-500" strokeWidth={2} />
          <span className="truncate">Transcript</span>
        </div>
        <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-zinc-500">
          <span className="hidden sm:inline">Model</span>
          <select
            value={whisperModel}
            onChange={onWhisperModelSelect}
            disabled={isBusy}
            className="max-w-[9rem] rounded-md border border-zinc-700 bg-zinc-900 py-1 pl-2 pr-6 text-[11px] text-zinc-200 sm:max-w-[10.5rem]"
            title="Larger Whisper models need more RAM/VRAM and run slower but transcribe more accurately."
          >
            <option value="" disabled>
              Choose model…
            </option>
            {WHISPER_MODEL_OPTIONS.map((o) => (
              <option key={o.id} value={o.id} title={o.hint}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex-1" />
        <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-[11px] text-zinc-500 sm:justify-start">
          <span>
            {project.head?.n_ops ?? 0} edit{project.head?.n_ops === 1 ? "" : "s"}
          </span>
          <span className="text-zinc-700">·</span>
          <span className={cn("inline-flex items-center gap-1", project.canUndo ? "text-zinc-400" : "text-zinc-700")}>
            <Undo2 className="h-3 w-3 shrink-0 opacity-80" strokeWidth={2} />
            <Kbd>{mod}</Kbd>
            <Kbd>Z</Kbd>
          </span>
          <span className={cn("inline-flex items-center gap-1", project.canRedo ? "text-zinc-400" : "text-zinc-700")}>
            <Redo2 className="h-3 w-3 shrink-0 opacity-80" strokeWidth={2} />
            <Kbd>{mod}</Kbd>
            <Kbd>⇧</Kbd>
            <Kbd>Z</Kbd>
          </span>
        </div>
        <button
          type="button"
          onClick={onPickVideo}
          disabled={isBusy || !whisperModel.trim()}
          title={
            !whisperModel.trim()
              ? "Choose a Whisper model first"
              : undefined
          }
          className={cn(
            "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-medium transition-colors",
            isBusy || !whisperModel.trim()
              ? "cursor-not-allowed border-transparent bg-zinc-900/40 text-zinc-600 opacity-50"
              : "border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-zinc-600 hover:bg-zinc-800",
          )}
        >
          <FileVideo className="h-3.5 w-3.5" strokeWidth={2} />
          {mediaPath !== null ? "Other video" : "Open video"}
        </button>
      </header>

      {bootstrapMediaPath &&
      !whisperModel.trim() &&
      status.kind === "idle" && (
        <div className="flex shrink-0 items-start gap-2 border-b border-violet-900/35 bg-violet-950/20 px-3 py-2 text-[11px] text-violet-100/95">
          <Mic className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-400/90" strokeWidth={2} />
          <p className="min-w-0 leading-snug">
            <span className="font-semibold text-violet-200">Media Pool</span> — ready to transcribe{" "}
            <span className="font-mono text-zinc-200">{basename(bootstrapMediaPath)}</span>.
            Choose a <span className="text-zinc-300">Whisper model</span> above; transcription starts
            automatically.
          </p>
        </div>
      )}

      {mediaPath !== null && (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-zinc-800/80 bg-zinc-900/35 px-3 text-[11px]">
          <Mic className="h-3.5 w-3.5 shrink-0 text-zinc-600" strokeWidth={2} />
          <span className="shrink-0 text-zinc-500">Source</span>
          <span className="min-w-0 flex-1 truncate font-mono text-zinc-300" title={mediaPath}>
            {basename(mediaPath)}
          </span>
          {transcript !== null && (
            <span className="hidden shrink-0 text-zinc-500 sm:inline">
              {keptWordCount} / {transcript.words.length} kept · {transcript.language}
            </span>
          )}
        </div>
      )}

      {transcript !== null &&
        transcript.segments.some((s) => s.speaker != null && String(s.speaker).length > 0) && (
          <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-zinc-800/60 bg-zinc-900/25 px-3 py-1.5 text-[10px] text-zinc-500">
            <span className="font-semibold uppercase tracking-wide text-zinc-600">Speakers</span>
            <span className="text-zinc-600">(from Analyze)</span>
            <span className="min-w-0 truncate font-mono text-zinc-400">
              {[...new Set(transcript.segments.map((s) => s.speaker).filter(Boolean))].join(" · ")}
            </span>
          </div>
        )}

      {autoClean !== null && project.head?.head === autoClean.afterHead ? (
        <div className="flex min-h-9 shrink-0 flex-col gap-1 border-b border-emerald-900/40 bg-emerald-950/25 px-3 py-1.5 text-[11px] text-emerald-100/95 sm:flex-row sm:items-start sm:justify-between sm:gap-2 sm:py-1">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="inline-flex items-start gap-2">
              <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400/90" strokeWidth={2} />
              <span className="min-w-0">
                Removed <strong className="font-semibold">{autoClean.count}</strong> filler sound
                {autoClean.count === 1 ? "" : "s"}. One{" "}
                <span className="inline-flex items-center gap-0.5 align-middle">
                  <Kbd>{mod}</Kbd>
                  <Kbd>Z</Kbd>
                </span>{" "}
                undoes the batch.
              </span>
            </span>
            {autoCleanRemovedWordsPreview !== null ? (
              <p
                className="truncate pl-[calc(1.375rem+0.5rem)] font-mono text-[10px] leading-snug text-emerald-200/75"
                title={autoCleanRemovedWordsTitle || undefined}
              >
                <span className="text-emerald-400/80">Words:</span> {autoCleanRemovedWordsPreview}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => void onUndoAutoClean()}
            disabled={!project.canUndo}
            className="inline-flex h-7 shrink-0 items-center gap-1 self-end rounded-md border border-emerald-700/60 bg-emerald-900/40 px-2 font-medium text-emerald-50 hover:bg-emerald-800/50 disabled:cursor-not-allowed disabled:opacity-40 sm:self-start"
          >
            <RotateCcw className="h-3.5 w-3.5" strokeWidth={2} />
            Undo
          </button>
        </div>
      ) : null}

      {silenceStrip !== null && project.head?.head === silenceStrip.afterHead ? (
        <div className="flex min-h-9 shrink-0 flex-col gap-1 border-b border-sky-900/40 bg-sky-950/20 px-3 py-1.5 text-[11px] text-sky-100/95 sm:flex-row sm:items-start sm:justify-between sm:gap-2 sm:py-1">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="inline-flex items-start gap-2">
              <VolumeX className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-400/90" strokeWidth={2} />
              <span className="min-w-0">
                Stripped <strong className="font-semibold">{silenceStrip.count}</strong> mostly-silent token
                {silenceStrip.count === 1 ? "" : "s"} (FFmpeg silencedetect vs Whisper). One{" "}
                <span className="inline-flex items-center gap-0.5 align-middle">
                  <Kbd>{mod}</Kbd>
                  <Kbd>Z</Kbd>
                </span>{" "}
                undoes the batch.
              </span>
            </span>
            {silenceStripRemovedWordsPreview !== null ? (
              <p
                className="truncate pl-[calc(1.375rem+0.5rem)] font-mono text-[10px] leading-snug text-sky-200/75"
                title={silenceStripRemovedWordsTitle || undefined}
              >
                <span className="text-sky-400/80">Words:</span> {silenceStripRemovedWordsPreview}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => void onUndoSilenceStrip()}
            disabled={!project.canUndo}
            className="inline-flex h-7 shrink-0 items-center gap-1 self-end rounded-md border border-sky-700/60 bg-sky-900/35 px-2 font-medium text-sky-50 hover:bg-sky-800/45 disabled:cursor-not-allowed disabled:opacity-40 sm:self-start"
          >
            <RotateCcw className="h-3.5 w-3.5" strokeWidth={2} />
            Undo
          </button>
        </div>
      ) : null}

      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-1 flex-col overflow-hidden">
          <TranscriptBody
            status={status}
            transcript={transcript}
            deleted={deleted}
            onToggleWord={onToggleWord}
            onPickVideo={onPickVideo}
            onDismissError={onDismissError}
          />

          {transcript !== null && status.kind !== "ingesting" && (
            <footer className="flex min-h-12 shrink-0 flex-col gap-1 border-t border-zinc-800/80 bg-[var(--cut-bg-panel)] px-3 py-1.5">
              <details className="text-[11px] text-zinc-500">
                <summary className="cursor-pointer select-none text-zinc-600 hover:text-zinc-400">
                  Export & caption options
                </summary>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pb-0.5">
                  <label className="inline-flex items-center gap-1">
                    <span className="text-zinc-600">Video scale</span>
                    <select
                      value={exportVideoPreset}
                      onChange={(e) => setExportVideoPreset(e.target.value as ExportVideoPresetId)}
                      disabled={isBusy}
                      className="rounded border border-zinc-700 bg-zinc-900 py-0.5 pl-1 pr-6 text-[11px] text-zinc-200"
                    >
                      {(Object.keys(EXPORT_VIDEO_PRESET_LABELS) as ExportVideoPresetId[]).map((id) => (
                        <option key={id} value={id}>
                          {EXPORT_VIDEO_PRESET_LABELS[id]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="inline-flex cursor-pointer items-center gap-1.5 text-zinc-500">
                    <input
                      type="checkbox"
                      checked={burnInCaptions}
                      onChange={(e) => setBurnInCaptions(e.target.checked)}
                      disabled={isBusy}
                      className="rounded border-zinc-600 bg-zinc-900"
                    />
                    <span>Burn-in captions</span>
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <span className="text-zinc-600">Sidecar</span>
                    <select
                      value={captionSidecarFormat}
                      onChange={(e) => setCaptionSidecarFormat(e.target.value as CaptionSidecarFormat)}
                      disabled={isBusy}
                      className="rounded border border-zinc-700 bg-zinc-900 py-0.5 pl-1 pr-6 text-[11px] text-zinc-200"
                    >
                      <option value="srt">SubRip (.srt)</option>
                      <option value="vtt">WebVTT (.vtt)</option>
                    </select>
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <span className="text-zinc-600">Caption style</span>
                    <select
                      value={captionStylePreset}
                      onChange={(e) => setCaptionStylePreset(e.target.value as CaptionStylePresetId)}
                      disabled={isBusy}
                      className="max-w-[9rem] rounded border border-zinc-700 bg-zinc-900 py-0.5 pl-1 pr-6 text-[11px] text-zinc-200"
                      title={CAPTION_STYLE_PRESETS[captionStylePreset].hint}
                    >
                      {(Object.keys(CAPTION_STYLE_PRESETS) as CaptionStylePresetId[]).map((id) => (
                        <option key={id} value={id} title={CAPTION_STYLE_PRESETS[id].hint}>
                          {CAPTION_STYLE_PRESETS[id].label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </details>
              <details className="text-[11px] text-zinc-500">
                <summary className="cursor-pointer select-none text-zinc-600 hover:text-zinc-400">
                  Analyze & dead-air strip
                </summary>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pb-0.5">
                  <label className="inline-flex items-center gap-1">
                    <span className="text-zinc-600">Scene threshold</span>
                    <input
                      type="number"
                      step={0.02}
                      min={0.1}
                      max={0.9}
                      value={sceneThreshold}
                      onChange={(e) => setSceneThreshold(Number.parseFloat(e.target.value) || 0.34)}
                      disabled={isBusy}
                      className="w-16 rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-[11px] text-zinc-200"
                      title="FFmpeg scene filter sensitivity (lower = more cuts)"
                    />
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <span className="text-zinc-600">Speaker gap (s)</span>
                    <input
                      type="number"
                      step={0.05}
                      min={0.2}
                      max={5}
                      value={speakerGapSeconds}
                      onChange={(e) => setSpeakerGapSeconds(Number.parseFloat(e.target.value) || 1.25)}
                      disabled={isBusy}
                      className="w-14 rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-[11px] text-zinc-200"
                      title="Minimum silence between Whisper segments to bump SPEAKER_xx (heuristic)"
                    />
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <span className="text-zinc-600">Diarization</span>
                    <select
                      value={diarizationMode}
                      onChange={(e) => setDiarizationMode(e.target.value as DiarizationRequestMode)}
                      disabled={isBusy}
                      className="max-w-[8rem] rounded border border-zinc-700 bg-zinc-900 py-0.5 pl-1 pr-6 text-[11px] text-zinc-200"
                      title="Pyannote needs pip install '.[diarize]' and SIFT_AI_HF_TOKEN on sift-ai"
                    >
                      <option value="auto">Auto (server default)</option>
                      <option value="heuristic">Gap heuristic</option>
                      <option value="pyannote">Pyannote</option>
                    </select>
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <span className="text-zinc-600">Silence noise dB</span>
                    <input
                      type="number"
                      step={1}
                      min={-90}
                      max={-10}
                      value={silenceNoiseDb}
                      onChange={(e) => setSilenceNoiseDb(Number.parseFloat(e.target.value) || -40)}
                      disabled={isBusy}
                      className="w-14 rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-[11px] text-zinc-200"
                    />
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <span className="text-zinc-600">Min silence (s)</span>
                    <input
                      type="number"
                      step={0.05}
                      min={0.08}
                      max={5}
                      value={silenceMinDuration}
                      onChange={(e) => setSilenceMinDuration(Number.parseFloat(e.target.value) || 0.45)}
                      disabled={isBusy}
                      className="w-14 rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-[11px] text-zinc-200"
                    />
                  </label>
                  <label className="inline-flex items-center gap-1">
                    <span className="text-zinc-600">Overlap</span>
                    <input
                      type="number"
                      step={0.05}
                      min={0.15}
                      max={1}
                      value={silenceOverlap}
                      onChange={(e) => setSilenceOverlap(Number.parseFloat(e.target.value) || 0.55)}
                      disabled={isBusy}
                      className="w-14 rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-[11px] text-zinc-200"
                      title="Min fraction of word duration overlapping silence to strip"
                    />
                  </label>
                </div>
              </details>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="flex min-w-0 flex-1 basis-[12rem] items-center gap-1.5 text-[11px] text-zinc-500">
                {deleted.size > 0 ? (
                  <button
                    type="button"
                    onClick={() => void onClearDeletions()}
                    className="truncate text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline"
                  >
                    Restore {deleted.size} deleted
                  </button>
                ) : (
                  <>
                    <MousePointerClick className="h-3.5 w-3.5 shrink-0 text-zinc-600" strokeWidth={2} />
                    <span className="text-zinc-600">
                      Click words to remove ·{" "}
                      <span className="inline-flex items-center gap-0.5 align-middle">
                        <Kbd>{mod}</Kbd>
                        <Kbd>Z</Kbd>
                      </span>{" "}
                      undo
                    </span>
                  </>
                )}
              </span>
              <button
                type="button"
                onClick={() => void onAutoCleanFillers()}
                disabled={status.kind === "exporting" || keptWordCount === 0}
                className={cn(
                  "inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors",
                  status.kind === "exporting" || keptWordCount === 0
                    ? "cursor-not-allowed border-transparent bg-zinc-900/40 text-zinc-600 opacity-40"
                    : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800",
                )}
                title="Remove detected filler sounds (uh, um, …) in one undo step"
              >
                <Eraser className="h-3.5 w-3.5" strokeWidth={2} />
                Auto-clean
              </button>
              <button
                type="button"
                onClick={() => void onAutoCleanSilence()}
                disabled={
                  status.kind === "exporting"
                  || keptWordCount === 0
                  || silenceStripBusy
                  || isBusy
                  || ingest === null
                }
                className={cn(
                  "inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors",
                  status.kind === "exporting"
                  || keptWordCount === 0
                  || silenceStripBusy
                  || isBusy
                  || ingest === null
                    ? "cursor-not-allowed border-transparent bg-zinc-900/40 text-zinc-600 opacity-40"
                    : "border-sky-800/50 bg-sky-950/25 text-sky-100 hover:bg-sky-900/35",
                )}
                title="Delete words that mostly overlap FFmpeg silencedetect intervals (one ⌘Z)"
              >
                {silenceStripBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
                ) : (
                  <VolumeX className="h-3.5 w-3.5" strokeWidth={2} />
                )}
                Strip silence
              </button>
              <button
                type="button"
                onClick={() => setRemovalDiffOpen(true)}
                disabled={deleted.size === 0 || isBusy}
                className={cn(
                  "inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors",
                  deleted.size === 0 || isBusy
                    ? "cursor-not-allowed border-transparent bg-zinc-900/40 text-zinc-600 opacity-40"
                    : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800",
                )}
                title="Compare original wording vs current cut"
              >
                <GitCompare className="h-3.5 w-3.5" strokeWidth={2} />
                Diff
              </button>
              <button
                type="button"
                onClick={() => void onPostprocessEnrich()}
                disabled={isBusy || enrichBusy || keptWordCount === 0}
                className={cn(
                  "inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors",
                  isBusy || enrichBusy || keptWordCount === 0
                    ? "cursor-not-allowed border-transparent bg-zinc-900/40 text-zinc-600 opacity-40"
                    : "border-violet-800/50 bg-violet-950/35 text-violet-100 hover:bg-violet-900/45",
                )}
                title="Scene cuts + speakers (pyannote optional, see Analyze options)"
              >
                {enrichBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" strokeWidth={2} />
                )}
                Analyze
              </button>
              {exportSummary !== null && (
                <span className="hidden max-w-[40%] truncate text-[11px] text-emerald-400 sm:inline" title={exportSummary.outputPath}>
                  {basename(exportSummary.outputPath)} ({formatBytes(exportSummary.sizeBytes)})
                </span>
              )}
              {captionNotice !== null ? (
                <span
                  className={cn(
                    "max-w-full truncate text-[11px]",
                    captionNotice.kind === "ok" ? "text-sky-400" : "text-rose-400",
                  )}
                  title={captionNotice.text}
                >
                  {captionNotice.kind === "ok" ? `Captions: ${captionNotice.text}` : captionNotice.text}
                </span>
              ) : null}
              {enrichNotice !== null ? (
                <span className="max-w-full truncate text-[11px] text-violet-400" title={enrichNotice}>
                  {enrichNotice}
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => void onExportCaptions()}
                disabled={status.kind === "exporting" || keptWordCount === 0}
                title="Export captions (.srt / .vtt). Times match exported recut timeline."
                className={cn(
                  "inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors",
                  status.kind === "exporting" || keptWordCount === 0
                    ? "cursor-not-allowed border-transparent bg-zinc-900/40 text-zinc-600 opacity-40"
                    : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800",
                )}
              >
                <Captions className="h-3.5 w-3.5" strokeWidth={2} />
                Captions
              </button>
              <button
                type="button"
                onClick={() => void onExport()}
                disabled={status.kind === "exporting" || keptWordCount === 0}
                className={cn(
                  "inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-3 text-[11px] font-medium transition-colors",
                  status.kind === "exporting" || keptWordCount === 0
                    ? "cursor-not-allowed bg-emerald-900/40 text-emerald-200/50 opacity-50"
                    : "bg-emerald-600 text-white hover:bg-emerald-500",
                )}
              >
                {status.kind === "exporting" ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
                    Exporting
                  </>
                ) : (
                  <>
                    <Download className="h-3.5 w-3.5" strokeWidth={2} />
                    Export
                  </>
                )}
              </button>
              </div>
            </footer>
          )}
        </div>
      </div>
      {removalDiffOpen && transcript !== null ? (
        <TranscriptRemovalDiff
          words={transcript.words}
          deleted={deleted}
          onClose={() => setRemovalDiffOpen(false)}
        />
      ) : null}
    </div>
  );
});

interface TranscriptBodyProps {
  status: Status;
  transcript: Transcript | null;
  deleted: ReadonlySet<number>;
  onToggleWord: (idx: number) => void | Promise<void>;
  onPickVideo: () => void;
  onDismissError: () => void;
}

function TranscriptBody({
  status,
  transcript,
  deleted,
  onToggleWord,
  onPickVideo,
  onDismissError,
}: TranscriptBodyProps) {
  const mod = modKeySymbol();
  const layoutItems = useMemo(() => {
    if (transcript === null || transcript.words.length === 0) return [];
    return layoutTranscriptWords(transcript.words);
  }, [transcript]);

  if (status.kind === "error") {
    return (
      <div className="flex flex-1 items-center justify-center px-8 py-6">
        <div className="max-w-lg space-y-4 text-center">
          <AlertCircle className="mx-auto h-11 w-11 text-rose-400/85" strokeWidth={1.5} />
          <div className="text-sm font-medium text-rose-400">
            Something went wrong
          </div>
          <div className="text-xs text-zinc-400">{status.message}</div>
          <div className="text-xs text-zinc-600">
            Start sift-ai from the <span className="font-mono text-zinc-500">sift-ai/</span> directory so it listens on{" "}
            <span className="font-mono text-zinc-500">127.0.0.1:8765</span>:
          </div>
          <div className="flex flex-col gap-2 font-mono text-[11px] text-zinc-300">
            <code className="rounded bg-zinc-900 px-2 py-1 text-left">python -m sift_ai</code>
            <span className="text-zinc-600">or</span>
            <code className="rounded bg-zinc-900 px-2 py-1 text-left">
              .venv/bin/uvicorn sift_ai.server:app --reload --host 127.0.0.1 --port 8765
            </code>
          </div>
          <button
            type="button"
            onClick={onDismissError}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  if (status.kind === "transcribing") {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="space-y-4 text-center">
          <div className="flex items-center justify-center gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-zinc-500" strokeWidth={2} />
            <Mic className="h-8 w-8 text-violet-400/75" strokeWidth={1.75} />
          </div>
          <div className="text-sm text-zinc-200">Transcribing…</div>
          <div className="max-w-sm text-xs leading-relaxed text-zinc-500">
            faster-whisper is running. Short clips finish in seconds; the first run may be slower while the model downloads.
          </div>
        </div>
      </div>
    );
  }

  if (status.kind === "ingesting") {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="space-y-4 text-center">
          <Loader2 className="mx-auto h-9 w-9 animate-spin text-zinc-500" strokeWidth={2} />
          <div className="text-sm text-zinc-200">Loading transcript into engine…</div>
          <div className="max-w-sm text-xs leading-relaxed text-zinc-500">
            Each word becomes a clip on the timeline. Edits, undo, and export run through the engine.
          </div>
        </div>
      </div>
    );
  }

  if (status.kind === "exporting") {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="space-y-4 text-center">
          <div className="flex items-center justify-center gap-2">
            <Loader2 className="h-8 w-8 animate-spin text-emerald-400/70" strokeWidth={2} />
            <Download className="h-7 w-7 text-emerald-500/50" strokeWidth={1.75} />
          </div>
          <div className="text-sm text-zinc-200">Exporting…</div>
          <div className="text-xs text-zinc-500">
            FFmpeg is re-encoding the kept ranges.
          </div>
        </div>
      </div>
    );
  }

  if (transcript === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="space-y-5 text-center">
          <FileVideo className="mx-auto h-12 w-12 text-zinc-600" strokeWidth={1.25} />
          <div className="text-sm text-zinc-300">
            Transcribe a video to edit by words.
          </div>
          <button
            type="button"
            onClick={onPickVideo}
            className="inline-flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-100 hover:border-zinc-600 hover:bg-zinc-800"
          >
            <FileVideo className="h-4 w-4" strokeWidth={2} />
            Open video
          </button>
          <div className="max-w-sm text-xs leading-relaxed text-zinc-600">
            Or stay on <span className="text-zinc-500">Timeline</span>, import in Media, then{" "}
            <strong className="font-medium text-zinc-500">Transcribe…</strong> — we open this tab when a Whisper model is
            selected.
          </div>
          <div className="text-xs text-zinc-600">
            Toggle words to remove them; export keeps the rest.{" "}
            <span className="inline-flex items-center gap-0.5 align-middle">
              <Kbd>{mod}</Kbd>
              <Kbd>Z</Kbd>
            </span>{" "}
            undoes edits.
          </div>
        </div>
      </div>
    );
  }

  if (transcript.words.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-xs text-zinc-500">
          Whisper found no speech in this clip.
        </div>
      </div>
    );
  }

  const layout = layoutItems;

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4">
      <div className="flex max-w-4xl flex-wrap content-start items-baseline gap-x-1.5 gap-y-2 leading-relaxed text-[15px] text-zinc-100">
        {layout.map((item, j) => {
          if (item.kind === "paragraph") {
            return (
              <span
                key={`para-${j}`}
                className="basis-full shrink-0 pt-5"
                aria-hidden
              />
            );
          }
          if (item.kind === "stamp") {
            return (
              <span
                key={`stamp-${j}`}
                className="inline whitespace-nowrap align-baseline font-mono text-[11px] tabular-nums text-zinc-500 select-none"
              >
                {formatParenTimestamp(item.seconds)}
              </span>
            );
          }
          const i = item.index;
          const w = transcript.words[i]!;
          const isDeleted = deleted.has(i);
          return (
            <button
              key={`w-${i}`}
              type="button"
              onClick={() => void onToggleWord(i)}
              title={`${formatParenTimestamp(clipSecondsFromTicks(w.start_ticks))} · p=${w.probability.toFixed(2)}`}
              className={
                "inline shrink-0 rounded px-1 py-0.5 align-baseline transition-colors "
                + (isDeleted
                  ? "bg-rose-900/30 text-rose-300/60 line-through hover:bg-rose-900/50"
                  : "text-zinc-100 hover:bg-zinc-800")
              }
            >
              {whisperChipLabel(w.word)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
