/**
 * Read-only transcript layout for the editor: inline timestamps like `(1:17)`
 * and paragraph breaks after long silent gaps — purely derived from word timings.
 */

import { TICKS_PER_SECOND } from "./time";

export interface TranscriptWordTiming {
  start_ticks: number;
  end_ticks: number;
}

export type TranscriptLayoutItem =
  | { kind: "paragraph" }
  | { kind: "stamp"; seconds: number }
  | { kind: "word"; index: number };

export interface LayoutTranscriptWordsOptions {
  /** Gap between consecutive words (seconds); above this → new timestamp. */
  pause_sec?: number;
  /** During continuous speech, emit at most one timestamp per this many seconds. */
  rhythm_sec?: number;
  /** Start a new visual paragraph after this much silence between words. */
  paragraph_gap_sec?: number;
}

const DEFAULT_PAUSE = 1.35;
const DEFAULT_RHYTHM = 5;
const DEFAULT_PARAGRAPH = 12;

function ticksToSecondsFloor(start_ticks: number): number {
  return Number(BigInt(start_ticks) / TICKS_PER_SECOND);
}

/** Clip seconds (floored) for display aligned with stamp rounding. */
export function clipSecondsFromTicks(start_ticks: number): number {
  return ticksToSecondsFloor(start_ticks);
}

/**
 * Whisper tokens sometimes carry a **leading space** as the word boundary
 * (" the", " word"); other producers emit bare tokens ("the", "word"). To
 * render adjacent word buttons with visible separation regardless of the
 * source convention, we collapse whitespace, trim, then prepend a U+00A0
 * (NBSP). NBSP survives CSS whitespace collapsing on inline elements,
 * where a regular space character would not.
 */
export function whisperChipLabel(raw: string): string {
  const collapsed = raw.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return collapsed;
  // U+00A0 NBSP — escaped explicitly so the no-irregular-whitespace
  // lint rule doesn't flag literal NBSP. CSS preserves NBSP across
  // inline elements where it would collapse a regular space.
  return `\u00A0${collapsed}`;
}

/**
 * `(m:ss)` — minutes without forced zero-padding (matches common captions).
 */
export function formatParenTimestamp(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `(${m}:${sec.toString().padStart(2, "0")})`;
}

/**
 * Flat stream used by the transcript pane: optional paragraph break, optional
 * stamp, then word indices in original order.
 */
export function layoutTranscriptWords(
  words: readonly TranscriptWordTiming[],
  options?: LayoutTranscriptWordsOptions,
): TranscriptLayoutItem[] {
  const pauseSec = options?.pause_sec ?? DEFAULT_PAUSE;
  const rhythmSec = options?.rhythm_sec ?? DEFAULT_RHYTHM;
  const paragraphGapSec = options?.paragraph_gap_sec ?? DEFAULT_PARAGRAPH;

  const out: TranscriptLayoutItem[] = [];
  let lastStampClipSec = -Infinity;

  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const sec = ticksToSecondsFloor(w.start_ticks);

    if (i > 0) {
      const prev = words[i - 1]!;
      const gapTicks = BigInt(w.start_ticks) - BigInt(prev.end_ticks);
      const gapSec = Number(gapTicks) / Number(TICKS_PER_SECOND);
      if (gapSec >= paragraphGapSec) {
        out.push({ kind: "paragraph" });
      }
    }

    if (i === 0) {
      out.push({ kind: "stamp", seconds: sec });
      lastStampClipSec = sec;
    } else {
      const prev = words[i - 1]!;
      const gapTicks = BigInt(w.start_ticks) - BigInt(prev.end_ticks);
      const gapSec = Number(gapTicks) / Number(TICKS_PER_SECOND);
      const needStamp =
        gapSec >= pauseSec || sec - lastStampClipSec >= rhythmSec;
      if (needStamp) {
        out.push({ kind: "stamp", seconds: sec });
        lastStampClipSec = sec;
      }
    }

    out.push({ kind: "word", index: i });
  }

  return out;
}
