/**
 * Shared transcript-driven op builders.
 *
 * Extracted from `TranscriptEditorPane` so the chat planner (and any
 * future stub or LLM tool-use planner) can compute the same edit ops
 * without poking inside a component. Pure functions — no engine, no
 * AI, no React.
 */
import type { Transcript } from "./aiClient";
import { asId, type ClipId, type Op } from "./ops";
import { detectFillers } from "./transcriptCleanup";
import { TICKS_PER_SECOND } from "./time";

/** Result of transcript-to-engine ingest: word-index → clip-id map. */
export interface IngestResult {
  /** Map from word index in `Transcript.words` to the clip id assigned during ingest. */
  wordToClipId: ReadonlyMap<number, string>;
  /**
   * Map from word index to the *timeline* position the clip was
   * inserted at during ingest. We need this to re-insert a clip
   * after the user un-deletes a word — the engine packs clips on
   * the timeline at positions different from their source times
   * (Whisper words often have overlapping source ranges), so
   * `timeline_at` is not recoverable from `word.start_ticks`.
   *
   * Stored as plain JS `number` to keep the value JSON-serialisable
   * for the per-video ingest sidecar. Callers convert to `BigInt`
   * when building engine ops.
   */
  wordToTimelineAt: ReadonlyMap<number, number>;
}

/** A snapshot of the current transcript + ingest state. */
export interface TranscriptState {
  transcript: Transcript;
  ingest: IngestResult;
  /**
   * Word indices the user (or a prior AI edit) has already removed
   * from the cut. Required for accurate snippet previews — without it
   * we'd show deleted words as still present.
   */
  deleted: ReadonlySet<number>;
  /** Absolute path to the source media on disk, if known. */
  sourcePath?: string;
}

/**
 * Build a batch of `clip_delete` ops for every detected filler word
 * that was successfully ingested.
 */
export function buildFillerDeleteOps(
  state: TranscriptState,
): { ops: Op[]; wordIndices: number[] } {
  const fillerIdx = detectFillers(state.transcript.words);
  const ops: Op[] = [];
  const wordIndices: number[] = [];
  for (const idx of fillerIdx) {
    const clipId = state.ingest.wordToClipId.get(idx);
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

/**
 * Build a batch of `clip_delete` ops for every transcript word whose
 * source range falls fully inside `[startSecs, endSecs]`.
 *
 * Used by the stub planner (and, eventually, Claude tool-use) to
 * resolve natural-language references like "drop 2:23 to 3:45" to
 * concrete word-level delete ops. Words already deleted are
 * skipped; zero-duration words (never ingested) are skipped.
 */
export function buildRangeDeleteOps(
  state: TranscriptState,
  startSecs: number,
  endSecs: number,
): { ops: Op[]; wordIndices: number[] } {
  if (!(endSecs > startSecs)) {
    return { ops: [], wordIndices: [] };
  }
  const tps = Number(TICKS_PER_SECOND);
  const startTicks = startSecs * tps;
  const endTicks = endSecs * tps;
  const ops: Op[] = [];
  const wordIndices: number[] = [];
  for (let i = 0; i < state.transcript.words.length; i++) {
    const w = state.transcript.words[i]!;
    if (w.start_ticks >= startTicks && w.end_ticks <= endTicks) {
      if (state.deleted.has(i)) continue;
      const clipId = state.ingest.wordToClipId.get(i);
      if (clipId === undefined) continue;
      wordIndices.push(i);
      ops.push({
        kind: "clip_delete",
        clip_id: asId<"ClipId">(clipId) as ClipId,
        ripple: false,
      });
    }
  }
  return { ops, wordIndices };
}

/**
 * Build a batch of `clip_delete` ops for an explicit set of word indices.
 * Used by silence-strip and any future "delete these specific words" flow.
 *
 * - Deduplicates indices.
 * - Sorts ascending so the batch lands in source-time order
 *   (useful for human-readable op logs).
 * - Skips out-of-range indices and indices that map to no clip
 *   (zero-duration words were never ingested).
 */
export function buildWordIndexDeleteOps(
  state: TranscriptState,
  indices: readonly number[],
): { ops: Op[]; wordIndices: number[] } {
  const ops: Op[] = [];
  const wordIndices: number[] = [];
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  for (const idx of sorted) {
    if (idx < 0 || idx >= state.transcript.words.length) continue;
    const clipId = state.ingest.wordToClipId.get(idx);
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

/**
 * Imperative handle the transcript pane exposes for ref-based access
 * from other components (notably the chat panel via App.tsx).
 */
export interface TranscriptHandle {
  /** Returns the current transcript + ingest snapshot, or null when nothing is loaded. */
  getState(): TranscriptState | null;
  /** Convenience predicate. */
  hasTranscript(): boolean;
}
