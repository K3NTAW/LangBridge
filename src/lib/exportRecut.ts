/**
 * Pure helpers for **Export → `render_ranges` → cut-ai `/v1/recut`** (Phase 1 regression surface).
 */

import type { RecutRange } from "./aiClient";
import type { RenderRange } from "./engineClient";

/** Map engine kept-range rows into cut-ai recut payload (tick-aligned segments). */
export function renderRangesToRecutRanges(
  ranges: readonly RenderRange[],
): RecutRange[] {
  return ranges.map((r) => ({
    start_ticks: r.start_ticks,
    end_ticks: r.end_ticks,
  }));
}
