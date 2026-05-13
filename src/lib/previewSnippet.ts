/**
 * Compute the source ranges that *would* play if a candidate set of
 * additional word-deletions were applied to the current cut. Used by
 * the chat panel to render artifact previews before the user approves.
 *
 * Pure: no engine, no FFmpeg, no Tauri. Just transcript math.
 */
import type { PreviewRenderRange } from "./previewRender";
import { TICKS_PER_SECOND } from "./time";
import type { TranscriptState } from "./transcriptOps";

export interface SnippetOptions {
  /** Cap the snippet's total duration (seconds). Default 15s. */
  maxSecs?: number;
  /** Merge ranges with gaps below this (seconds). Default 100 ms. */
  mergeGapSecs?: number;
}

/** Default cap on snippet duration. */
export const DEFAULT_SNIPPET_MAX_SECS = 15;

/**
 * Compute the kept-word source ranges after applying `additionalDeletes`
 * to the user's already-deleted set, capped at `maxSecs` total duration.
 *
 * Algorithm:
 *   1. `kept = words[] \ (state.deleted ∪ additionalDeletes)`
 *   2. Sort by start_ticks; merge ranges whose gap is below `mergeGapSecs`
 *   3. Walk the merged list, accumulating duration until `maxSecs` is hit
 *   4. Last range is truncated to land exactly on the cap
 */
export function computeSnippetRangesAfterDeletes(
  state: TranscriptState,
  additionalDeletes: Iterable<number>,
  sourcePath: string,
  options: SnippetOptions = {},
): PreviewRenderRange[] {
  const maxSecs = Math.max(0.5, options.maxSecs ?? DEFAULT_SNIPPET_MAX_SECS);
  const mergeGapSecs = Math.max(0, options.mergeGapSecs ?? 0.1);

  const proposedDeleted = new Set<number>(state.deleted);
  for (const idx of additionalDeletes) proposedDeleted.add(idx);

  const tps = Number(TICKS_PER_SECOND);
  // Kept words → seconds-space (source_in, source_out).
  const keptRanges: { a: number; b: number }[] = [];
  state.transcript.words.forEach((w, idx) => {
    if (proposedDeleted.has(idx)) return;
    if (w.end_ticks <= w.start_ticks) return; // zero-duration words are unrenderable
    keptRanges.push({ a: w.start_ticks / tps, b: w.end_ticks / tps });
  });
  if (keptRanges.length === 0) return [];

  // Sort then merge adjacent (Whisper inter-word gaps are ~10ms).
  keptRanges.sort((x, y) => x.a - y.a);
  const merged: { a: number; b: number }[] = [];
  for (const r of keptRanges) {
    const last = merged[merged.length - 1];
    if (last && r.a - last.b <= mergeGapSecs) {
      last.b = Math.max(last.b, r.b);
    } else {
      merged.push({ a: r.a, b: r.b });
    }
  }

  // Accumulate up to the cap. Truncate the last range to land exactly on the cap.
  const out: PreviewRenderRange[] = [];
  let used = 0;
  for (const r of merged) {
    const remaining = maxSecs - used;
    if (remaining <= 0) break;
    const dur = r.b - r.a;
    if (dur <= remaining) {
      out.push({ source_path: sourcePath, src_in_secs: r.a, src_out_secs: r.b });
      used += dur;
    } else {
      out.push({
        source_path: sourcePath,
        src_in_secs: r.a,
        src_out_secs: r.a + remaining,
      });
      used = maxSecs;
      break;
    }
  }
  return out;
}
