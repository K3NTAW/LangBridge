/**
 * CutListPane — flat list of the kept ranges in the current engine
 * project. Useful for a sanity check before export: scan the rows,
 * confirm nothing important was clipped, then hit Export.
 *
 * Each row shows the source-time in/out, duration, and the leading
 * transcript words that fall inside the range (when a transcript is
 * available). Rows are read-only for now — clicking does not seek
 * (the player plays the source, the cut list is in source space,
 * and seeks have a UX of their own that we'd rather not bolt on
 * mid-list-render).
 */
import { ListOrdered, Sparkles } from "lucide-react";
import { useMemo } from "react";

import type { RenderRangesResult } from "../lib/engineClient";
import type { Transcript } from "../lib/aiClient";
import { TICKS_PER_SECOND } from "../lib/time";

interface Props {
  /** Current render plan from the engine, or null when none loaded. */
  ranges: RenderRangesResult | null;
  /** Transcript for the active video, used to label each row with words. */
  transcript: Transcript | null;
  /** Whether a video is selected at all — drives the empty-state copy. */
  hasVideo: boolean;
}

function ticksToSeconds(t: number): number {
  return Number(BigInt(t)) / Number(TICKS_PER_SECOND);
}

/** Format seconds as `M:SS` (or `H:MM:SS` past one hour). */
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = s.toString().padStart(2, "0");
  if (h > 0) {
    const mm = m.toString().padStart(2, "0");
    return `${h}:${mm}:${ss}`;
  }
  return `${m}:${ss}`;
}

/** Format seconds as a duration: "0.43s", "2.1s", "1:23". */
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  if (seconds < 60) return `${seconds.toFixed(seconds < 1 ? 2 : 1)}s`;
  return formatTime(seconds);
}

/**
 * Pull the transcript words whose source range sits inside `[start, end]`.
 * Returns the first `limit` words joined as a preview snippet — enough
 * to give the user a "feel" for what each row contains.
 */
function wordsInRange(
  transcript: Transcript | null,
  startTicks: number,
  endTicks: number,
  limit = 14,
): string {
  if (!transcript) return "";
  const words: string[] = [];
  for (const w of transcript.words) {
    if (w.start_ticks >= startTicks && w.end_ticks <= endTicks) {
      words.push(w.word.trim());
      if (words.length >= limit) {
        words.push("…");
        break;
      }
    }
  }
  return words.join(" ");
}

export function CutListPane({ ranges, transcript, hasVideo }: Props) {
  const rows = ranges?.ranges ?? [];

  const totals = useMemo(() => {
    if (rows.length === 0) return { count: 0, durationSecs: 0 };
    let dur = 0;
    for (const r of rows) {
      dur += ticksToSeconds(r.end_ticks - r.start_ticks);
    }
    return { count: rows.length, durationSecs: dur };
  }, [rows]);

  if (!hasVideo) {
    return (
      <div className="empty">
        <div className="icon-wrap">
          <ListOrdered size={20} strokeWidth={1.75} />
        </div>
        <div className="empty-headline">Pick a video to see the cut list</div>
        <div className="empty-sub">
          Open a folder, choose a clip, and Sift will show every kept range here.
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="empty">
        <div className="icon-wrap">
          <Sparkles size={20} strokeWidth={1.75} />
        </div>
        <div className="empty-headline">Nothing in the cut yet</div>
        <div className="empty-sub">
          Once you delete a word in the Transcript or apply an edit from chat, this
          list shows what survives.
        </div>
      </div>
    );
  }

  return (
    <div className="cutlist-pane">
      <div className="cutlist-summary">
        <span className="cutlist-summary-label">
          <ListOrdered size={12} strokeWidth={2} />
          {totals.count} range{totals.count === 1 ? "" : "s"}
        </span>
        <span className="sep">·</span>
        <span className="cutlist-summary-label t-mono">
          {formatTime(totals.durationSecs)} total
        </span>
      </div>
      <div className="cutlist-rows">
        {rows.map((r, i) => {
          const startS = ticksToSeconds(r.start_ticks);
          const endS = ticksToSeconds(r.end_ticks);
          const durS = endS - startS;
          const preview = wordsInRange(transcript, r.start_ticks, r.end_ticks);
          return (
            <div className="cutlist-row" key={`${r.source_id}-${r.start_ticks}-${i}`}>
              <div className="cutlist-row-idx t-mono">#{i + 1}</div>
              <div className="cutlist-row-body">
                <div className="cutlist-row-times t-mono">
                  <span>{formatTime(startS)}</span>
                  <span className="cutlist-row-arrow">→</span>
                  <span>{formatTime(endS)}</span>
                  <span className="cutlist-row-duration">({formatDuration(durS)})</span>
                </div>
                {preview ? (
                  <div className="cutlist-row-preview" title={preview}>
                    {preview}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
