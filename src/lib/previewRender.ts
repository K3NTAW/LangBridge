/**
 * Segment-cache preview renderer (Sift v0).
 *
 * Given the engine's current render plan — a list of `(source_id,
 * src_in, src_out)` ranges — produce a flattened MP4 the `<video>`
 * element can play. Caches per-segment renders keyed by content hash
 * so unchanged ranges are reused across edits.
 *
 * See PIVOT-PLAN.md §5.5 for the design.
 *
 * Status: stubs. Implementation lands in Milestone A.
 */

/** One range from the engine's render plan. */
export interface PreviewRenderRange {
  sourceId: string;
  /** Absolute path to the source media on disk. */
  sourcePath: string;
  /** Tick boundaries in the engine's integer-tick rate. */
  startTicks: bigint;
  endTicks: bigint;
}

/** Encoder parameters applied to every segment so concat-by-copy works. */
export interface PreviewEncoderParams {
  codec: "h264";
  /** Long-edge in pixels. Preview is 1280; export is full-res. */
  maxEdge: number;
  /** Constant-rate-factor for x264. */
  crf: number;
  /** Audio sample rate. */
  audioRate: number;
  /** Audio codec. */
  audioCodec: "aac";
}

/** Result of a preview render. */
export interface PreviewRenderResult {
  /** Absolute path to the flattened preview MP4. */
  outputPath: string;
  /** Total duration of the cut in seconds (approximate). */
  durationSecs: number;
  /** Number of cached segments reused. */
  cacheHits: number;
  /** Number of segments that had to be rendered fresh. */
  cacheMisses: number;
}

export const DEFAULT_PREVIEW_PARAMS: PreviewEncoderParams = {
  codec: "h264",
  maxEdge: 1280,
  crf: 23,
  audioRate: 48_000,
  audioCodec: "aac",
};

/**
 * Compute the cache key for a single range. The hash is over
 * (sourcePath, startTicks, endTicks, encoderParams) so that any
 * change to the cut or encoder invalidates only what's affected.
 *
 * **Not yet implemented.**
 */
export function segmentCacheKey(
  _range: PreviewRenderRange,
  _params: PreviewEncoderParams = DEFAULT_PREVIEW_PARAMS,
): string {
  throw new Error("segmentCacheKey: not implemented yet (Milestone A)");
}

/**
 * Render the current render plan to a preview MP4. Reuses cached
 * segments for ranges whose hash is already on disk; renders missing
 * ones via FFmpeg; concatenates with `ffmpeg -f concat -c copy`.
 *
 * **Not yet implemented.**
 */
export async function renderPreview(
  _ranges: PreviewRenderRange[],
  _cacheDir: string,
  _params: PreviewEncoderParams = DEFAULT_PREVIEW_PARAMS,
): Promise<PreviewRenderResult> {
  throw new Error("renderPreview: not implemented yet (Milestone A)");
}

/** Bound the cache to a size budget. Evicts oldest segments first. */
export async function pruneSegmentCache(
  _cacheDir: string,
  _maxBytes: number,
): Promise<{ evicted: number; remainingBytes: number }> {
  throw new Error("pruneSegmentCache: not implemented yet (Milestone A)");
}
