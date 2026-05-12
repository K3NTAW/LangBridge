/**
 * Natural-language time-range parsing (Sift v0).
 *
 * Resolves user-supplied time references against the current
 * transcript so they can be sent to Claude as concrete tick ranges.
 *
 * Examples we want to handle in Milestone B:
 *   "2:23"             → { start: 2:23, end: null }
 *   "2:23-3:45"        → { start: 2:23, end: 3:45 }
 *   "from 2:23 to 3:45" → same
 *   "the intro"        → first ~30s of transcript
 *   "where she mentions the trip" → semantic lookup (later)
 *
 * Status: tick-form parser stubbed; English / semantic forms land in
 * Milestone B.
 */
import { secondsToTicksApprox, type Tick } from "./time";

export interface TimeRange {
  start: Tick;
  /** null = open-ended (to end of timeline). */
  end: Tick | null;
}

/** Strict `m:ss` / `h:mm:ss` / `s` parse. Returns seconds or null. */
export function parseClockToSeconds(input: string): number | null {
  const t = input.trim();
  if (!t) return null;
  // Plain seconds: "12" or "12.5"
  if (/^\d+(?:\.\d+)?$/.test(t)) {
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  // m:ss or h:mm:ss
  const m = /^(\d+):(\d{1,2})(?::(\d{1,2}))?(?:\.(\d{1,3}))?$/.exec(t);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = m[3] !== undefined ? Number(m[3]) : null;
  const frac = m[4] !== undefined ? Number(`0.${m[4]}`) : 0;
  if (c !== null) {
    // h:mm:ss[.fff]
    if (b >= 60 || c >= 60) return null;
    return a * 3600 + b * 60 + c + frac;
  }
  // m:ss[.fff]
  if (b >= 60) return null;
  return a * 60 + b + frac;
}

/**
 * Best-effort range parse for v0 — handles the clock-form variants we
 * promise above. Semantic ("the intro", "where she mentions X") will
 * be added in Milestone B by querying the local embedding index.
 *
 * Returns `null` if nothing usable was found.
 */
export function parseTimeRange(input: string): TimeRange | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;

  // "from X to Y", "X-Y", "X — Y"
  const fromTo = /(?:from\s+)?([\d.:]+)\s*(?:-|–|—|to)\s*([\d.:]+)/.exec(text);
  if (fromTo) {
    const a = parseClockToSeconds(fromTo[1] ?? "");
    const b = parseClockToSeconds(fromTo[2] ?? "");
    if (a !== null && b !== null && b > a) {
      return { start: secondsToTicksApprox(a), end: secondsToTicksApprox(b) };
    }
  }

  // "at X" or "X" alone — start with open end
  const single = /(?:at\s+)?([\d.:]+)\b/.exec(text);
  if (single) {
    const a = parseClockToSeconds(single[1] ?? "");
    if (a !== null) {
      return { start: secondsToTicksApprox(a), end: null };
    }
  }

  // Semantic refs land later — return null for now so the planner gets
  // the raw command and can ask a follow-up question instead of getting
  // a fabricated range.
  return null;
}
