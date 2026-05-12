/**
 * SubRip (.srt) captions from Whisper word timings — **clean style** (simple wraps, no burn-in).
 */

import type { TranscriptWord } from "./aiClient";
import type { RenderRange } from "./engineClient";
import { TICKS_PER_SECOND } from "./time";

export interface CaptionBuildOptions {
  /** Max characters before splitting onto a second line inside one cue. */
  maxLineChars: number;
  /** Start a new cue after this many kept words (approximate sentence chunk). */
  maxWordsPerCue: number;
  /** Pause longer than this between words → new cue (ticks). */
  gapTicksNewCue: bigint;
}

export const DEFAULT_CAPTION_OPTIONS: CaptionBuildOptions = {
  maxLineChars: 42,
  maxWordsPerCue: 12,
  gapTicksNewCue: TICKS_PER_SECOND / 2n,
};

/** `HH:MM:SS,mmm` for SubRip (comma separates fractional seconds). */
export function ticksToSrtTimestamp(ticks: bigint): string {
  const t = ticks < 0n ? 0n : ticks;
  const totalMs = (t * 1000n) / TICKS_PER_SECOND;
  const ms = totalMs % 1000n;
  const totalSec = totalMs / 1000n;
  const s = totalSec % 60n;
  const totalMin = totalSec / 60n;
  const m = totalMin % 60n;
  const h = totalMin / 60n;
  const p2 = (n: bigint) => n.toString().padStart(2, "0");
  const p3 = (n: bigint) => n.toString().padStart(3, "0");
  return `${p2(h)}:${p2(m)}:${p2(s)},${p3(ms)}`;
}

function wrapCueBody(text: string, maxLineChars: number): string {
  const t = text.trim();
  if (t.length <= maxLineChars) return t;
  const breakAt = t.lastIndexOf(" ", maxLineChars);
  if (breakAt > maxLineChars / 2) {
    return `${t.slice(0, breakAt)}\n${t.slice(breakAt + 1).trimStart()}`;
  }
  return `${t.slice(0, maxLineChars)}\n${t.slice(maxLineChars).trimStart()}`;
}

/** One caption cue on the export timeline (after optional range remap). */
export interface CaptionCue {
  startTicks: bigint;
  endTicks: bigint;
  text: string;
}

/** Sort kept source spans from [`renderRanges`] for timeline mapping. */
export function sortRenderRangesForCaptions(ranges: readonly RenderRange[]): RenderRange[] {
  return [...ranges].sort((a, b) => a.start_ticks - b.start_ticks || a.end_ticks - b.end_ticks);
}

/**
 * Map a **source** media tick to **output** timeline ticks after concatenating kept ranges
 * in sorted order (matches `/v1/recut` segment order).
 */
export function sourcePointToOutputTick(t: bigint, rangesSorted: readonly RenderRange[]): bigint {
  let acc = 0n;
  for (const r of rangesSorted) {
    const s = BigInt(r.start_ticks);
    const e = BigInt(r.end_ticks);
    if (e <= s) continue;
    if (t <= s) return acc;
    if (t < e) return acc + (t - s);
    acc += e - s;
  }
  return acc;
}

function remapKeptWordsToExportTimeline(
  kept: readonly TranscriptWord[],
  rangesSorted: readonly RenderRange[],
): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  for (const w of kept) {
    const os = sourcePointToOutputTick(BigInt(w.start_ticks), rangesSorted);
    const oe = sourcePointToOutputTick(BigInt(w.end_ticks), rangesSorted);
    if (oe <= os) continue;
    out.push({
      ...w,
      start_ticks: Number(os),
      end_ticks: Number(oe),
    });
  }
  return out;
}

/** `HH:MM:SS.mmm` for WebVTT (period before milliseconds). */
export function ticksToVttTimestamp(ticks: bigint): string {
  const t = ticks < 0n ? 0n : ticks;
  const totalMs = (t * 1000n) / TICKS_PER_SECOND;
  const ms = totalMs % 1000n;
  const totalSec = totalMs / 1000n;
  const s = totalSec % 60n;
  const totalMin = totalSec / 60n;
  const m = totalMin % 60n;
  const h = totalMin / 60n;
  const p2 = (n: bigint) => n.toString().padStart(2, "0");
  const p3 = (n: bigint) => n.toString().padStart(3, "0");
  return `${p2(h)}:${p2(m)}:${p2(s)}.${p3(ms)}`;
}

export function buildCaptionCues(
  words: readonly TranscriptWord[],
  deleted: ReadonlySet<number>,
  options: CaptionBuildOptions,
  keptSourceRanges?: readonly RenderRange[] | null,
): CaptionCue[] {
  const kept: TranscriptWord[] = [];
  for (let i = 0; i < words.length; i++) {
    if (deleted.has(i)) continue;
    const w = words[i];
    if (w === undefined) continue;
    const raw = w.word.trim();
    if (raw.length === 0) continue;
    kept.push(w);
  }

  if (kept.length === 0) return [];

  const rangesSorted =
    keptSourceRanges !== undefined && keptSourceRanges !== null && keptSourceRanges.length > 0
      ? sortRenderRangesForCaptions(keptSourceRanges)
      : null;
  const timelineWords =
    rangesSorted !== null && rangesSorted.length > 0 ? remapKeptWordsToExportTimeline(kept, rangesSorted) : kept;

  if (timelineWords.length === 0) return [];

  const cues: CaptionCue[] = [];
  let cueStart = BigInt(timelineWords[0]!.start_ticks);
  let cueEnd = BigInt(timelineWords[0]!.end_ticks);
  let cueWords = [timelineWords[0]!.word.trim()];
  let wordsInCue = 1;

  const flushCue = () => {
    const body = cueWords.join(" ");
    if (body.length > 0) {
      cues.push({
        startTicks: cueStart,
        endTicks: cueEnd < cueStart ? cueStart : cueEnd,
        text: wrapCueBody(body, options.maxLineChars),
      });
    }
  };

  for (let k = 1; k < timelineWords.length; k++) {
    const prev = timelineWords[k - 1]!;
    const cur = timelineWords[k]!;
    const prevEnd = BigInt(prev.end_ticks);
    const curStart = BigInt(cur.start_ticks);
    const gap = curStart > prevEnd ? curStart - prevEnd : 0n;
    const nextToken = cur.word.trim();
    const trial = `${cueWords.join(" ")} ${nextToken}`.trim();
    const tooManyWords = wordsInCue >= options.maxWordsPerCue;
    const longPause = gap > options.gapTicksNewCue;
    const tooLong = trial.length > options.maxLineChars * 2;

    if (longPause || tooManyWords || tooLong) {
      flushCue();
      cueStart = curStart;
      cueEnd = BigInt(cur.end_ticks);
      cueWords = [nextToken];
      wordsInCue = 1;
    } else {
      cueWords.push(nextToken);
      cueEnd = BigInt(cur.end_ticks);
      wordsInCue += 1;
    }
  }
  flushCue();

  return cues;
}

export function formatCaptionCuesAsSrt(cues: readonly CaptionCue[]): string {
  return cues
    .map((c, i) => {
      const start = ticksToSrtTimestamp(c.startTicks);
      const end = ticksToSrtTimestamp(c.endTicks);
      return `${i + 1}\n${start} --> ${end}\n${c.text}\n`;
    })
    .join("\n");
}

export function formatCaptionCuesAsWebVtt(cues: readonly CaptionCue[]): string {
  const body = cues
    .map((c, i) => {
      const start = ticksToVttTimestamp(c.startTicks);
      const end = ticksToVttTimestamp(c.endTicks);
      return `${i + 1}\n${start} --> ${end}\n${c.text}`;
    })
    .join("\n\n");
  return `WEBVTT\n\n${body}\n`;
}

export function buildCaptionsVttFromWords(
  words: readonly TranscriptWord[],
  deleted: ReadonlySet<number>,
  options: CaptionBuildOptions = DEFAULT_CAPTION_OPTIONS,
  keptSourceRanges?: readonly RenderRange[] | null,
): string {
  return formatCaptionCuesAsWebVtt(buildCaptionCues(words, deleted, options, keptSourceRanges));
}

export function buildCaptionsSrtFromWords(
  words: readonly TranscriptWord[],
  deleted: ReadonlySet<number>,
  options: CaptionBuildOptions = DEFAULT_CAPTION_OPTIONS,
  keptSourceRanges?: readonly RenderRange[] | null,
): string {
  return formatCaptionCuesAsSrt(buildCaptionCues(words, deleted, options, keptSourceRanges));
}

export function suggestCaptionsVttPath(mediaPath: string): string {
  const dot = mediaPath.lastIndexOf(".");
  const base = dot === -1 ? mediaPath : mediaPath.slice(0, dot);
  return `${base}.captions.vtt`;
}

export function suggestCaptionsPath(mediaPath: string): string {
  const dot = mediaPath.lastIndexOf(".");
  const base = dot === -1 ? mediaPath : mediaPath.slice(0, dot);
  return `${base}.captions.srt`;
}
