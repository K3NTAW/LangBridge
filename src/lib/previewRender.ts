/**
 * Preview renderer orchestration (Sift Milestone A slice 3).
 *
 * Composition:
 *   • engine.renderRanges() — what's in the current cut, in tick space.
 *   • engine.previewPrimaryMedia() — resolves the source path (v0 is
 *     single-source).
 *   • Tauri `preview_render_flatten` — FFmpeg filter_complex concat.
 *   • fs.readFile + Blob URL — gets the rendered MP4 to the `<video>`
 *     element without re-enabling the asset protocol.
 *
 * Today this re-encodes the entire cut on every call. The segment-cache
 * optimisation (PIVOT-PLAN.md §5.5) lands as a follow-up once we have a
 * working end-to-end baseline.
 */
import { invoke } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";

import { getEngineClient } from "./engineClient";
import { TICKS_PER_SECOND } from "./time";

/** One range to render, source path already resolved. Sent to the Tauri command. */
export interface PreviewRenderRange {
  source_path: string;
  src_in_secs: number;
  src_out_secs: number;
}

/** Mirrors `preview_render::PreviewRenderResult` on the Rust side. */
export interface PreviewRenderResult {
  output_path: string;
  duration_secs: number;
  range_count: number;
}

/** Cap on the longer edge of the preview frame in pixels. */
export const DEFAULT_PREVIEW_MAX_EDGE = 1280;

/**
 * Merge ranges with sub-`gapSecs` gaps in the same source into a single
 * continuous range. This is critical for transcript-driven editing:
 * Whisper produces ~10 ms gaps between word timestamps, so a 5-minute
 * transcript with no deletes can otherwise generate 1000+ ranges, and
 * FFmpeg's `filter_complex` chokes on the resulting graph.
 *
 * Operates on ranges *within the same source path*; ranges from
 * different sources never merge.
 *
 * The default gap of 100 ms is a heuristic — large enough to swallow
 * Whisper's inter-word gaps and tiny rounding errors, small enough that
 * a user-deleted word (typically ≥150 ms long) is preserved as a real
 * gap.
 */
export function mergePreviewRanges(
  ranges: PreviewRenderRange[],
  gapSecs = 0.1,
): PreviewRenderRange[] {
  if (ranges.length <= 1) return ranges.slice();
  const sorted = ranges.slice().sort((a, b) => {
    if (a.source_path !== b.source_path) {
      return a.source_path.localeCompare(b.source_path);
    }
    return a.src_in_secs - b.src_in_secs;
  });
  const merged: PreviewRenderRange[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.source_path === r.source_path &&
      r.src_in_secs - last.src_out_secs <= gapSecs
    ) {
      last.src_out_secs = Math.max(last.src_out_secs, r.src_out_secs);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/** Hard cap to keep FFmpeg's `filter_complex` tractable. */
export const MAX_PREVIEW_RANGES = 250;

/**
 * Build a `PreviewRenderRange[]` from the engine's current render plan
 * by querying the engine for ranges + the primary-media source path.
 *
 * Returns an empty array when the timeline has no clips. Throws when
 * the engine is unreachable or no primary media is resolvable.
 */
export async function buildPreviewRangesFromEngine(): Promise<PreviewRenderRange[]> {
  const client = getEngineClient();
  const rr = await client.renderRanges();
  if (rr.ranges.length === 0) return [];

  const ppm = await client.previewPrimaryMedia();
  const tps = Number(TICKS_PER_SECOND);
  const raw: PreviewRenderRange[] = rr.ranges.map((r) => ({
    source_path: ppm.path,
    src_in_secs: r.start_ticks / tps,
    src_out_secs: r.end_ticks / tps,
  }));
  return mergePreviewRanges(raw);
}

/**
 * Invoke the Tauri command that runs FFmpeg over the supplied ranges.
 * The output_path's parent directory will be created if missing.
 */
export async function renderPreviewToFile(
  ranges: PreviewRenderRange[],
  outputPath: string,
  maxEdge: number = DEFAULT_PREVIEW_MAX_EDGE,
): Promise<PreviewRenderResult> {
  return await invoke<PreviewRenderResult>("preview_render_flatten", {
    ranges,
    outputPath,
    maxEdge,
  });
}

/**
 * Read a rendered preview file off disk and return a Blob URL the
 * `<video>` element can play.
 *
 * Caller is responsible for revoking the returned URL via
 * `URL.revokeObjectURL` when it's no longer needed (e.g. when a new
 * preview supersedes this one).
 */
export async function previewFileToBlobUrl(path: string): Promise<string> {
  const bytes = await readFile(path);
  // Force a real ArrayBuffer-backed copy so we don't keep the underlying
  // Uint8Array alive longer than necessary.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const blob = new Blob([ab], { type: "video/mp4" });
  return URL.createObjectURL(blob);
}

/**
 * End-to-end: pull the render plan from the engine, render via FFmpeg,
 * read the result, return a Blob URL. Returns `null` when the timeline
 * is empty (no preview to show).
 *
 * The output file is written to `outputPath` so it survives across
 * renders for cache reuse later.
 */
export async function renderCurrentPreviewBlobUrl(
  outputPath: string,
): Promise<{ blobUrl: string; result: PreviewRenderResult } | null> {
  const ranges = await buildPreviewRangesFromEngine();
  if (ranges.length === 0) return null;
  if (ranges.length > MAX_PREVIEW_RANGES) {
    throw new Error(
      `Too many preview ranges (${ranges.length} after merge, cap ${MAX_PREVIEW_RANGES}). ` +
        `This usually means many small gaps in the source — try Cut Silences first.`,
    );
  }
  const result = await renderPreviewToFile(ranges, outputPath);
  const blobUrl = await previewFileToBlobUrl(result.output_path);
  return { blobUrl, result };
}
