/**
 * Tick-based time arithmetic — TypeScript mirror of `sift-engine/src/time.rs`.
 *
 * See {@link https://../docs/spec.md docs/spec.md §1} for the contract.
 *
 * **Critical:** all timeline arithmetic in this app must use this module.
 * Floats drift; integer ticks do not.
 */

/**
 * Discrete time, in ticks at {@link TICKS_PER_SECOND}.
 *
 * We use `bigint` (not `number`) because JavaScript's safe integer ceiling
 * is 2^53-1, and ticks at 254 016 000 Hz multiplied across project ranges
 * can exceed it. See ADR-004.
 */
export type Tick = bigint;

/**
 * Base tick rate. LCM of common video frame rates and audio sample rates;
 * see the table in `docs/spec.md`.
 */
export const TICKS_PER_SECOND = 254_016_000n;

/** A frame rate or sample rate as an exact ratio. */
export interface Rate {
  readonly num: number;
  readonly den: number;
}

/** Common rates as constants. */
export const Rates = {
  fps24: { num: 24, den: 1 },
  fps23_976: { num: 24_000, den: 1001 },
  fps25: { num: 25, den: 1 },
  fps29_97: { num: 30_000, den: 1001 },
  fps30: { num: 30, den: 1 },
  fps48: { num: 48, den: 1 },
  fps50: { num: 50, den: 1 },
  fps60: { num: 60, den: 1 },
  fps120: { num: 120, den: 1 },
  audio48k: { num: 48_000, den: 1 },
  audio44_1k: { num: 44_100, den: 1 },
} as const satisfies Record<string, Rate>;

/**
 * Period in ticks of one frame at this rate, or `null` when the rate
 * doesn't divide evenly into {@link TICKS_PER_SECOND} (e.g. 29.97 fps).
 *
 * Exact rates: use the period directly for snap-to-frame.
 * Inexact rates: use {@link snapToRate}.
 */
export function framePeriodTicks(rate: Rate): Tick | null {
  const numerator = TICKS_PER_SECOND * BigInt(rate.den);
  const num = BigInt(rate.num);
  return numerator % num === 0n ? numerator / num : null;
}

/**
 * Snap a tick to the nearest frame boundary at the given rate.
 * Round half-away-from-zero.
 */
export function snapToRate(t: Tick, rate: Rate): Tick {
  const period = framePeriodTicks(rate);
  if (period !== null) {
    const half = period / 2n;
    if (t >= 0n) return ((t + half) / period) * period;
    return ((t - half) / period) * period;
  }
  // NTSC path: convert via exact rationals.
  const num = BigInt(rate.num);
  const den = BigInt(rate.den);
  const tps = TICKS_PER_SECOND;
  const scaled = t * num;
  const divisor = tps * den;
  const half = divisor / 2n;
  const frame = scaled >= 0n ? (scaled + half) / divisor : (scaled - half) / divisor;
  return (frame * tps * den) / num;
}

/** Convert a tick to seconds as a `number`. **For display only.** */
export function ticksToSecondsF64(t: Tick): number {
  return Number(t) / Number(TICKS_PER_SECOND);
}

/**
 * Approximate seconds → ticks for UI scrubbing (rounded to nearest tick).
 * Prefer engine-backed integer durations when available; use this only at I/O boundaries.
 */
export function secondsToTicksApprox(seconds: number): Tick {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0n;
  return BigInt(Math.round(seconds * Number(TICKS_PER_SECOND)));
}

/**
 * Format a tick as `HH:MM:SS:FF` timecode at the given rate.
 *
 * Drop-frame timecode (the colon-then-semicolon `HH:MM:SS;FF` form) is a
 * UI concern parked for v1.5; for now we format non-drop only. NTSC rates
 * display a slightly slow clock, which is acceptable for v0.
 */
export function formatTimecode(t: Tick, rate: Rate): string {
  const totalFrames = Number((t * BigInt(rate.num)) / (TICKS_PER_SECOND * BigInt(rate.den)));
  const fps = Math.round(rate.num / rate.den);
  const frames = ((totalFrames % fps) + fps) % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
}
