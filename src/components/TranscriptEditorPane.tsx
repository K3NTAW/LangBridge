/**
 * Transcript editor — wedge UI, **engine-backed**.
 *
 * Flow:
 *   1. Pick a video (Tauri file dialog), **or** bootstrap from Media Pool **Transcribe…**
 *      (same Whisper + ingest pipeline).
 *   2. cut-ai runs Whisper, returns word-level timestamps.
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
 *   6. Export → `engine.renderRanges()` → cut-ai recut from those
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
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertCircle,
  Download,
  Eraser,
  FileVideo,
  Loader2,
  Mic,
  MousePointerClick,
  Redo2,
  RotateCcw,
  ScrollText,
  Sparkles,
  Undo2,
} from "lucide-react";

import {
  AIServiceError,
  getAIClient,
  type RecutRange,
  type Transcript,
} from "../lib/aiClient";
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
import { detectFillers } from "../lib/transcriptCleanup";
import { WHISPER_MODEL_OPTIONS } from "../lib/whisperModels";
import { cn } from "../lib/cn";
import { modKeySymbol } from "../lib/modKey";
import { Kbd } from "./ui/Kbd";

interface Props {
  project: UseEngineProject;
  /** From Media Pool "Transcribe…": auto-run Whisper + word ingest once path is set. */
  bootstrapMediaPath?: string | null;
  onBootstrapConsumed?: () => void;
  /** Whisper model id, or "" until the user selects one (onboarding). */
  whisperModel: string;
  onWhisperModelChange: (modelId: string) => void;
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

interface IngestResult {
  /** Map from word index to the clip id assigned during ingest. */
  wordToClipId: ReadonlyMap<number, string>;
}

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

/** Build batched `ClipDelete` ops for detected filler words that were ingested. */
function buildFillerDeleteOps(
  transcript: Transcript,
  ingest: IngestResult,
): { ops: Op[]; wordIndices: number[] } {
  const fillerIdx = detectFillers(transcript.words);
  const ops: Op[] = [];
  const wordIndices: number[] = [];
  for (const idx of fillerIdx) {
    const clipId = ingest.wordToClipId.get(idx);
    if (clipId === undefined) continue;
    wordIndices.push(idx);
    ops.push({
      kind: "clip_delete",
      clip_id: asId<"ClipId">(clipId) as ClipId,
      ripple: false,
    });
  }
  return { ops, wordIndices };
}

function suggestOutputPath(input: string): string {
  const dot = input.lastIndexOf(".");
  if (dot === -1) return `${input}.cut.mp4`;
  return `${input.substring(0, dot)}.cut${input.substring(dot)}`;
}

export function TranscriptEditorPane({
  project,
  bootstrapMediaPath = null,
  onBootstrapConsumed,
  whisperModel,
  onWhisperModelChange,
}: Props) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [ingest, setIngest] = useState<IngestResult | null>(null);
  const [deleted, setDeleted] = useState<ReadonlySet<number>>(new Set());
  const [exportSummary, setExportSummary] = useState<ExportSummary | null>(null);
  const [autoClean, setAutoClean] = useState<AutoCleanState | null>(null);

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

  const keptWordCount = useMemo(() => {
    if (transcript === null) return 0;
    return transcript.words.length - deleted.size;
  }, [transcript, deleted]);

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
        setStatus({ kind: "transcribing", mediaPath: picked });

        let transcriptResult: Transcript;
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
        }

        setStatus({ kind: "ready", mediaPath: picked, transcript: transcriptResult });
      } finally {
        transcribeLockRef.current = false;
      }
    },
    [project, whisperModel],
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
    setStatus({ kind: "exporting", mediaPath, transcript });
    try {
      const recutRanges: RecutRange[] = ranges.ranges.map((r) => ({
        start_ticks: r.start_ticks,
        end_ticks: r.end_ticks,
      }));
      const result = await getAIClient().recut(mediaPath, out, recutRanges);
      setExportSummary({
        outputPath: result.output_path,
        sizeBytes: result.size_bytes,
        nRanges: result.n_ranges,
      });
      setStatus({ kind: "ready", mediaPath, transcript });
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
    }
  }, [project, transcript, mediaPath]);

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

      {autoClean !== null && project.head?.head === autoClean.afterHead ? (
        <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-emerald-900/40 bg-emerald-950/25 px-3 text-[11px] text-emerald-100/95">
          <span className="inline-flex items-start gap-2">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400/90" strokeWidth={2} />
            <span>
              Removed <strong className="font-semibold">{autoClean.count}</strong> filler sound
              {autoClean.count === 1 ? "" : "s"}. One{" "}
              <span className="inline-flex items-center gap-0.5 align-middle">
                <Kbd>{mod}</Kbd>
                <Kbd>Z</Kbd>
              </span>{" "}
              undoes the batch.
            </span>
          </span>
          <button
            type="button"
            onClick={() => void onUndoAutoClean()}
            disabled={!project.canUndo}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-emerald-700/60 bg-emerald-900/40 px-2 font-medium text-emerald-50 hover:bg-emerald-800/50 disabled:cursor-not-allowed disabled:opacity-40"
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
            <footer className="flex h-12 shrink-0 items-center gap-2 border-t border-zinc-800/80 bg-[var(--cut-bg-panel)] px-3">
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-zinc-500">
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
              {exportSummary !== null && (
                <span className="hidden max-w-[40%] truncate text-[11px] text-emerald-400 sm:inline" title={exportSummary.outputPath}>
                  {basename(exportSummary.outputPath)} ({formatBytes(exportSummary.sizeBytes)})
                </span>
              )}
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
            </footer>
          )}
        </div>
      </div>
    </div>
  );
}

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
            Start cut-ai from the <span className="font-mono text-zinc-500">cut-ai/</span> directory so it listens on{" "}
            <span className="font-mono text-zinc-500">127.0.0.1:8765</span>:
          </div>
          <div className="flex flex-col gap-2 font-mono text-[11px] text-zinc-300">
            <code className="rounded bg-zinc-900 px-2 py-1 text-left">python -m cut_ai</code>
            <span className="text-zinc-600">or</span>
            <code className="rounded bg-zinc-900 px-2 py-1 text-left">
              .venv/bin/uvicorn cut_ai.server:app --reload --host 127.0.0.1 --port 8765
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
