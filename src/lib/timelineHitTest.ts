import type { TimelineClipLayoutWire } from "./engineClient";
import type { Tick } from "./time";

/** Clip whose timeline span strictly contains `playhead` (for `clip_split` `at`). */
export function clipUnderPlayheadStrict(
  playhead: Tick,
  clips: readonly TimelineClipLayoutWire[],
): TimelineClipLayoutWire | null {
  for (const c of clips) {
    const start = BigInt(c.timeline_at);
    const end = start + BigInt(c.duration_ticks);
    if (playhead > start && playhead < end) return c;
  }
  return null;
}

/** Clip whose `[timeline_at, timeline_at + duration)` contains `playhead` (for `clip_delete`). */
export function clipContainingPlayhead(
  playhead: Tick,
  clips: readonly TimelineClipLayoutWire[],
): TimelineClipLayoutWire | null {
  for (const c of clips) {
    const start = BigInt(c.timeline_at);
    const end = start + BigInt(c.duration_ticks);
    if (playhead >= start && playhead < end) return c;
  }
  return null;
}
