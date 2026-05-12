import { Film, Pause, Play, Scissors, Trash2 } from "lucide-react";
import { useCallback, useMemo, type PointerEvent } from "react";

import type { TimelineClipLayoutWire } from "../lib/engineClient";
import { cn } from "../lib/cn";
import type { Op } from "../lib/ops";
import { asId, type ClipId } from "../lib/ops";
import { clipContainingPlayhead, clipUnderPlayheadStrict } from "../lib/timelineHitTest";
import { formatTimecode, Rates, secondsToTicksApprox, ticksToSecondsF64, type Tick } from "../lib/time";
import { ulidLite } from "../lib/ulid";

const TRACK_LABEL_PX = 48;
const FALLBACK_VISIBLE_DURATION_SEC = 30;

/** Left edge (% of timeline span) for a tick position. */
function timelineLeftPct(at: bigint, extent: bigint): number {
  if (extent <= 0n) return 0;
  const x = Number((at * 100n) / extent);
  return Math.min(100, Math.max(0, x));
}

/** Width (% of timeline span) for a duration; keeps thin clips visible. */
function timelineWidthPct(dur: bigint, extent: bigint): number {
  if (extent <= 0n) return 0;
  const raw = Number((dur * 100n) / extent);
  return Math.min(100, Math.max(0.22, raw));
}

interface Props {
  playheadTicks: Tick;
  onPlayheadTicksChange: (t: Tick) => void;
  /** Playback / scrub extent (preview cap or edit timeline length). */
  playbackExtentSeconds: number | null;
  /** Primary video track clips from `timeline_layout`. */
  clips: readonly TimelineClipLayoutWire[];
  timelineDurationTicks: number;
  playing: boolean;
  onTogglePlay: () => void;
  hasProject: boolean;
  engineBusy: boolean;
  applyOp: (op: Op) => Promise<unknown>;
}

/**
 * Timeline pane — ruler, primary video track from engine layout, skeleton lanes V2/A1.
 */
export function TimelinePane({
  playheadTicks,
  onPlayheadTicksChange,
  playbackExtentSeconds,
  clips,
  timelineDurationTicks,
  playing,
  onTogglePlay,
  hasProject,
  engineBusy,
  applyOp,
}: Props) {
  const tc = formatTimecode(playheadTicks, Rates.fps24);
  const canPlay = playbackExtentSeconds !== null && playbackExtentSeconds > 0;

  const splitTarget = useMemo(
    () => clipUnderPlayheadStrict(playheadTicks, clips),
    [playheadTicks, clips],
  );
  const deleteTarget = useMemo(
    () => clipContainingPlayhead(playheadTicks, clips),
    [playheadTicks, clips],
  );

  const onSplitAtPlayhead = useCallback(async () => {
    if (!splitTarget || !hasProject || engineBusy) return;
    const op: Op = {
      kind: "clip_split",
      clip_id: asId<"ClipId">(splitTarget.clip_id) as ClipId,
      at: playheadTicks,
      new_clip_id: asId<"ClipId">(ulidLite()) as ClipId,
    };
    await applyOp(op);
  }, [splitTarget, hasProject, engineBusy, playheadTicks, applyOp]);

  const onDeleteRippleAtPlayhead = useCallback(async () => {
    if (!deleteTarget || !hasProject || engineBusy) return;
    const op: Op = {
      kind: "clip_delete",
      clip_id: asId<"ClipId">(deleteTarget.clip_id) as ClipId,
      ripple: true,
    };
    await applyOp(op);
  }, [deleteTarget, hasProject, engineBusy, applyOp]);

  const extentTicks = useMemo(() => {
    let e =
      Number.isFinite(timelineDurationTicks) && timelineDurationTicks > 0
        ? BigInt(timelineDurationTicks)
        : 0n;
    if (e <= 0n && clips.length > 0) {
      for (const c of clips) {
        const end = BigInt(c.timeline_at) + BigInt(c.duration_ticks);
        if (end > e) e = end;
      }
    }
    return e;
  }, [timelineDurationTicks, clips]);

  const scrubFromClientX = useCallback(
    (clientX: number, rect: DOMRect, labelInsetPx: number) => {
      if (playbackExtentSeconds === null || playbackExtentSeconds <= 0) return;
      const usable = rect.width - labelInsetPx;
      if (usable <= 0) return;
      const x = clientX - rect.left - labelInsetPx;
      const ratio = Math.min(1, Math.max(0, x / usable));
      onPlayheadTicksChange(secondsToTicksApprox(ratio * playbackExtentSeconds));
    },
    [playbackExtentSeconds, onPlayheadTicksChange],
  );

  const bindScrubHandlers = (labelInsetPx: number) => ({
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      if (playbackExtentSeconds === null || playbackExtentSeconds <= 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      scrubFromClientX(e.clientX, e.currentTarget.getBoundingClientRect(), labelInsetPx);
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      scrubFromClientX(e.clientX, e.currentTarget.getBoundingClientRect(), labelInsetPx);
    },
    onPointerUp: (e: PointerEvent<HTMLDivElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    },
    onPointerCancel: (e: PointerEvent<HTMLDivElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    },
  });

  const fallbackDurationSecs =
    playbackExtentSeconds !== null && playbackExtentSeconds > 0
      ? playbackExtentSeconds
      : FALLBACK_VISIBLE_DURATION_SEC;
  const playheadPct =
    playbackExtentSeconds !== null && playbackExtentSeconds > 0
      ? Math.min(100, Math.max(0, (ticksToSecondsF64(playheadTicks) / playbackExtentSeconds) * 100))
      : Math.min(100, Math.max(0, (ticksToSecondsF64(playheadTicks) / fallbackDurationSecs) * 100));

  const scrubCursor =
    playbackExtentSeconds !== null && playbackExtentSeconds > 0 ? "cursor-pointer touch-none" : "cursor-default";

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-zinc-800/80 bg-[var(--cut-bg-panel)] px-3 text-xs text-zinc-400">
        <button
          type="button"
          disabled={!canPlay}
          onClick={onTogglePlay}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
          title={canPlay ? "Space" : "Load media to enable playback"}
        >
          {playing ? (
            <Pause className="h-3.5 w-3.5" strokeWidth={2} />
          ) : (
            <Play className="h-3.5 w-3.5 pl-0.5" strokeWidth={2} />
          )}
        </button>
        <span className="font-mono tabular-nums text-zinc-200">{tc}</span>
        <span className="text-zinc-600">·</span>
        <span>24 fps</span>
        <span className="text-zinc-600">·</span>
        <span>48 kHz</span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            disabled={!hasProject || engineBusy || splitTarget === null}
            onClick={() => void onSplitAtPlayhead()}
            className={cn(
              "inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors",
              !hasProject || engineBusy || splitTarget === null
                ? "cursor-not-allowed border-transparent bg-zinc-900/30 text-zinc-600 opacity-40"
                : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800",
            )}
            title="Split clip at playhead"
          >
            <Scissors className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
          <button
            type="button"
            disabled={!hasProject || engineBusy || deleteTarget === null}
            onClick={() => void onDeleteRippleAtPlayhead()}
            className={cn(
              "inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors",
              !hasProject || engineBusy || deleteTarget === null
                ? "cursor-not-allowed border-transparent bg-zinc-900/30 text-zinc-600 opacity-40"
                : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800",
            )}
            title="Delete clip at playhead (ripple)"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
          <span className="inline-flex items-center gap-1 rounded-md bg-zinc-900 px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500">
            <Film className="h-3 w-3 opacity-80" strokeWidth={2} />
            {clips.length === 0 ? "No clips" : `${clips.length} clip${clips.length === 1 ? "" : "s"}`}
          </span>
        </div>
      </div>

      <div
        className={`relative h-6 shrink-0 border-b border-zinc-800/80 bg-zinc-900/40 ${scrubCursor}`}
        {...bindScrubHandlers(0)}
      >
        {Array.from({ length: 30 }).map((_, i) => (
          <div key={i} className="absolute top-0 bottom-0 w-px bg-zinc-800" style={{ left: `${i * 3.33}%` }} />
        ))}
      </div>

      <div className="relative flex flex-1 flex-col overflow-hidden bg-[var(--cut-bg-deep)]">
        {(["V1", "V2", "A1"] as const).map((label, i) => (
          <div key={label} className="flex h-12 shrink-0 items-center border-b border-zinc-900 bg-track-bg/60">
            <div className="flex h-full w-12 shrink-0 items-center justify-center border-r border-zinc-800/60 text-[11px] font-medium text-zinc-500">
              {label}
            </div>
            <div className={`relative flex min-h-0 flex-1 select-none ${scrubCursor}`} {...bindScrubHandlers(0)}>
              {i === 0 && extentTicks > 0n && clips.length > 0 ? (
                clips.map((c, idx) => (
                  <div
                    key={c.clip_id}
                    title={c.clip_id}
                    className={cn(
                      "absolute top-2 bottom-2 box-border min-w-[3px] rounded-sm border",
                      idx % 2 === 0
                        ? "border-orange-600/50 bg-orange-500/22"
                        : "border-amber-600/45 bg-amber-500/18",
                    )}
                    style={{
                      left: `${timelineLeftPct(BigInt(c.timeline_at), extentTicks)}%`,
                      width: `${timelineWidthPct(BigInt(c.duration_ticks), extentTicks)}%`,
                    }}
                  />
                ))
              ) : null}
              {i === 1 ? (
                <div className="pointer-events-none absolute inset-x-3 top-1/2 h-px -translate-y-1/2 bg-zinc-800/80" />
              ) : null}
              {i === 2 ? (
                <div className="pointer-events-none absolute inset-x-3 top-1/2 h-px -translate-y-1/2 bg-zinc-800/80" />
              ) : null}
            </div>
          </div>
        ))}

        <div
          className="pointer-events-none absolute top-0 bottom-0 z-[1] w-px bg-track-playhead"
          style={{
            left: `calc(${TRACK_LABEL_PX}px + (100% - ${TRACK_LABEL_PX}px) * ${playheadPct / 100})`,
            boxShadow: "0 0 0 0.5px rgba(249,115,22,0.4)",
          }}
        />
      </div>
    </div>
  );
}
