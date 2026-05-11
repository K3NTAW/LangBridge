/**
 * Native preview: when the shell uses the engine timeline (no path override),
 * Tauri calls `preview_timeline_frame_png` → engine `preview_composite_frame`
 * (needs `cut-engine-host` built with `--features preview_compositor`).
 * Otherwise FFmpeg decodes by file path + seconds (`preview_frame_png`).
 * **GPU spike:** spawn `engine-spike` with `--ipc-stdin`; the host sends `seek`
 * lines so the separate wgpu window tracks timeline scrub/play when **Sync seeks** is enabled.
 */
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Film,
  FolderOpen,
  Gauge,
  Loader2,
  Monitor,
  RefreshCw,
  Unlink,
  Video,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { cn } from "../lib/cn";
import { EngineError, getEngineClient } from "../lib/engineClient";
import { previewProbe, type PreviewProbePayload } from "../lib/previewProbe";
import { secondsToTicksApprox, ticksToSecondsF64, type Tick } from "../lib/time";
import type { UseEngineProject } from "../lib/useEngineProject";

interface PreviewPngPayload {
  width: number;
  height: number;
  duration_seconds: number | null;
  png_base64: string;
}

interface Props {
  project: UseEngineProject;
  playheadTicks: Tick;
  onPlayheadTicksChange: (t: Tick) => void;
  onTimelineDurationSecondsChange: (seconds: number | null) => void;
  /** When the sequence has clips, caps scrub + duration sync to edit timeline length (seconds). */
  timelineEditExtentSeconds?: number | null;
  /** Softer PNG decode pacing during timeline playback (~24 Hz). */
  playing?: boolean;
}

function isTauriShell(): boolean {
  return typeof window !== "undefined" && Object.prototype.hasOwnProperty.call(window, "__TAURI_INTERNALS__");
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00.000";
  const s = Math.floor(seconds);
  const ms = Math.round((seconds - s) * 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
}

async function fetchPreviewFrame(path: string, seekSeconds: number, maxEdge = 1280): Promise<PreviewPngPayload> {
  // Tauri deserializes command args with camelCase keys (Rust `seek_seconds` → `seekSeconds`).
  return await invoke<PreviewPngPayload>("preview_frame_png", {
    path,
    seekSeconds,
    maxEdge,
  });
}

export function PreviewPane({
  project,
  playheadTicks,
  onPlayheadTicksChange,
  onTimelineDurationSecondsChange,
  timelineEditExtentSeconds = null,
  playing = false,
}: Props) {
  const inShell = isTauriShell();
  const [engineMedia, setEngineMedia] = useState<{
    source_id: string;
    path: string;
    preview_decode_path: string;
    duration_ticks: number;
  } | null>(null);
  const [mediaHint, setMediaHint] = useState<string | null>(null);
  const [overridePath, setOverridePath] = useState<string | null>(null);

  const [probe, setProbe] = useState<PreviewProbePayload | null>(null);
  const [decodeDurationSeconds, setDecodeDurationSeconds] = useState<number | null>(null);

  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [gpuWindowError, setGpuWindowError] = useState<string | null>(null);
  const [gpuSessionActive, setGpuSessionActive] = useState(false);
  const [gpuFollowTimeline, setGpuFollowTimeline] = useState(true);

  /** Resolved preview path: manual browse overrides timeline source; decode prefers proxy when set. */
  const videoPath = overridePath ?? engineMedia?.preview_decode_path ?? engineMedia?.path ?? null;

  useEffect(() => {
    setDecodeDurationSeconds(null);
    setGpuWindowError(null);
    setGpuSessionActive(false);
    setGpuFollowTimeline(true);
    if (inShell) {
      void invoke("preview_gpu_close").catch(() => {});
    }
    onPlayheadTicksChange(0n);
  }, [videoPath, onPlayheadTicksChange, inShell]);

  const engineDurationSecs = useMemo(() => {
    if (!engineMedia || engineMedia.duration_ticks <= 0) return null;
    return ticksToSecondsF64(BigInt(engineMedia.duration_ticks));
  }, [engineMedia]);

  /** Engine resolves `preview_decode_path` to proxy when file exists; manual browse skips this label. */
  const decodeUsesProxy = useMemo(() => {
    if (!engineMedia || overridePath != null) return false;
    const p = engineMedia.preview_decode_path.trim();
    const orig = engineMedia.path.trim();
    return p.length > 0 && orig.length > 0 && p !== orig;
  }, [engineMedia, overridePath]);

  const sliderMax = useMemo(() => {
    const fromProbe =
      probe !== null && probe.duration_seconds !== null && probe.duration_seconds > 0 ? probe.duration_seconds : null;
    const fromDecode =
      decodeDurationSeconds !== null && decodeDurationSeconds > 0 ? decodeDurationSeconds : null;
    const fromEngine = engineDurationSecs;
    return fromProbe ?? fromDecode ?? fromEngine ?? 120;
  }, [probe, decodeDurationSeconds, engineDurationSecs]);

  const playbackSliderMax = useMemo(() => {
    if (timelineEditExtentSeconds !== null && timelineEditExtentSeconds > 0) {
      return Math.min(sliderMax, timelineEditExtentSeconds);
    }
    return sliderMax;
  }, [sliderMax, timelineEditExtentSeconds]);

  useEffect(() => {
    setOverridePath(null);
  }, [project.head?.project_id, project.head?.head, project.head?.n_ops]);

  useEffect(() => {
    if (!inShell || !project.head) {
      setEngineMedia(null);
      setMediaHint(null);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const r = await getEngineClient().previewPrimaryMedia();
        if (!cancelled) {
          setEngineMedia({
            ...r,
            preview_decode_path: r.preview_decode_path ?? r.path,
          });
          setMediaHint(null);
        }
      } catch (e) {
        if (!cancelled) {
          setEngineMedia(null);
          const msg = e instanceof EngineError ? e.message : String(e);
          setMediaHint(msg);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [inShell, project.head]);

  useEffect(() => {
    if (!inShell || !videoPath) {
      setProbe(null);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const p = await previewProbe(videoPath);
        if (!cancelled) setProbe(p);
      } catch {
        if (!cancelled) setProbe(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [inShell, videoPath]);

  useEffect(() => {
    if (!videoPath) {
      onTimelineDurationSecondsChange(null);
      return;
    }
    onTimelineDurationSecondsChange(playbackSliderMax > 0 ? playbackSliderMax : null);
  }, [videoPath, playbackSliderMax, onTimelineDurationSecondsChange]);

  const seekSeconds = ticksToSecondsF64(playheadTicks);

  const loadFrame = useCallback(async () => {
    if (!inShell) return;
    setLoading(true);
    setDecodeError(null);
    try {
      let r: PreviewPngPayload;
      const preferEngineTimeline = Boolean(engineMedia) && overridePath == null;

      if (preferEngineTimeline) {
        try {
          r = await invoke<PreviewPngPayload>("preview_timeline_frame_png", {
            timelineTick: playheadTicks.toString(),
            maxEdge: 1280,
          });
        } catch (engineErr) {
          if (!videoPath) throw engineErr;
          const atSeconds = ticksToSecondsF64(playheadTicks);
          r = await fetchPreviewFrame(videoPath, atSeconds);
        }
      } else if (videoPath) {
        const atSeconds = ticksToSecondsF64(playheadTicks);
        r = await fetchPreviewFrame(videoPath, atSeconds);
      } else {
        return;
      }

      setDataUrl(`data:image/png;base64,${r.png_base64}`);
      if (r.duration_seconds !== null && r.duration_seconds > 0) {
        setDecodeDurationSeconds(r.duration_seconds);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setDecodeError(msg);
      setDataUrl(null);
    } finally {
      setLoading(false);
    }
  }, [inShell, videoPath, engineMedia, overridePath, playheadTicks]);

  useEffect(() => {
    if (!inShell || !videoPath) return;
    const delayMs = playing ? Math.round(1000 / 24) : 140;
    const id = window.setTimeout(() => {
      void loadFrame();
    }, delayMs);
    return () => window.clearTimeout(id);
  }, [inShell, videoPath, playheadTicks, loadFrame, playing]);

  useEffect(() => {
    if (!inShell || !gpuSessionActive || !gpuFollowTimeline || !videoPath) return;
    const id = window.setTimeout(() => {
      void invoke("preview_gpu_seek", { seekSeconds: ticksToSecondsF64(playheadTicks) }).catch(() => {});
    }, 90);
    return () => window.clearTimeout(id);
  }, [inShell, gpuSessionActive, gpuFollowTimeline, videoPath, playheadTicks]);

  const onPickVideo = useCallback(async () => {
    const picked = await openDialog({
      multiple: false,
      directory: false,
      title: "Override preview file",
      filters: [
        { name: "Video", extensions: ["mp4", "mov", "m4v", "mkv", "webm", "avi"] },
        { name: "Any", extensions: ["*"] },
      ],
    });
    if (typeof picked !== "string") return;
    setOverridePath(picked);
    setDecodeDurationSeconds(null);
    setDecodeError(null);
    onPlayheadTicksChange(0n);
  }, [onPlayheadTicksChange]);

  const clearOverride = useCallback(() => {
    setOverridePath(null);
    setDecodeDurationSeconds(null);
    setDecodeError(null);
    onPlayheadTicksChange(0n);
  }, [onPlayheadTicksChange]);

  const onOpenGpuWindow = useCallback(async () => {
    if (!videoPath) return;
    setGpuWindowError(null);
    try {
      await invoke("preview_gpu_window_open", { path: videoPath });
      setGpuSessionActive(true);
      setGpuFollowTimeline(true);
      await invoke("preview_gpu_seek", { seekSeconds: ticksToSecondsF64(playheadTicks) }).catch(() => {});
    } catch (e) {
      setGpuSessionActive(false);
      setGpuWindowError(e instanceof Error ? e.message : String(e));
    }
  }, [videoPath, playheadTicks]);

  if (!inShell) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[var(--cut-bg-deep)] px-6">
        <div className="max-w-md rounded-lg border border-zinc-800/70 bg-[var(--cut-bg-panel)] px-5 py-7 text-center text-sm text-zinc-400 shadow-inner">
          <Monitor className="mx-auto mb-3 h-9 w-9 text-zinc-600" strokeWidth={1.25} />
          <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Preview</div>
          <p className="mt-2 leading-relaxed">
            Native preview runs inside the Tauri desktop shell (FFmpeg decode → PNG). Use{" "}
            <span className="font-mono text-zinc-300">npm run tauri dev</span> to try it.
          </p>
        </div>
      </div>
    );
  }

  const timelineLabel = engineMedia?.path.split(/[/\\]/).pop();

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[var(--cut-bg-deep)] px-3 py-2.5">
      {!project.head ? (
        <p className="flex items-center justify-center gap-1.5 text-center text-[11px] text-zinc-500">
          <Film className="h-3.5 w-3.5 shrink-0 text-zinc-600" strokeWidth={2} />
          Load or create a project — preview follows the engine timeline when available.
        </p>
      ) : null}

      <div className="flex w-full max-w-5xl flex-wrap items-center justify-center gap-x-2 gap-y-2">
        <button
          type="button"
          onClick={() => void onPickVideo()}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-medium transition-colors",
            "border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-zinc-600 hover:bg-zinc-800",
          )}
        >
          <FolderOpen className="h-3.5 w-3.5" strokeWidth={2} />
          Browse
        </button>
        {videoPath ? (
          <button
            type="button"
            onClick={() => void onOpenGpuWindow()}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-medium transition-colors",
              "border-violet-800/50 bg-violet-950/35 text-violet-200 hover:bg-violet-900/45",
            )}
            title="Spawn engine-spike with stdin IPC (bundled or workspace binary). Separate OS window — not embedded in WebView."
          >
            <Gauge className="h-3.5 w-3.5" strokeWidth={2} />
            GPU
          </button>
        ) : null}
        {videoPath && gpuSessionActive ? (
          <label className="flex cursor-pointer items-center gap-1.5 rounded-md border border-zinc-800/90 bg-zinc-900/50 px-2 py-1 text-[11px] text-zinc-400">
            <input
              type="checkbox"
              className="rounded border-zinc-600 bg-zinc-900 accent-violet-500"
              checked={gpuFollowTimeline}
              onChange={(e) => setGpuFollowTimeline(e.target.checked)}
            />
            Sync GPU seeks
          </label>
        ) : null}
        {overridePath ? (
          <>
            <span className="flex max-w-[min(100%,14rem)] items-center gap-1 truncate font-mono text-[10px] text-amber-400/95" title={overridePath}>
              <Unlink className="h-3 w-3 shrink-0 text-amber-500/80" strokeWidth={2} />
              {overridePath.split(/[/\\]/).pop()}
            </span>
            <button
              type="button"
              onClick={clearOverride}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-transparent px-2 text-[10px] font-medium text-zinc-500 hover:border-zinc-800 hover:bg-zinc-900 hover:text-zinc-300"
            >
              <Video className="h-3 w-3" strokeWidth={2} />
              Timeline source
            </button>
          </>
        ) : timelineLabel ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="flex max-w-[min(100%,18rem)] items-center gap-1 truncate font-mono text-[10px] text-zinc-500" title={engineMedia?.path}>
              <Film className="h-3 w-3 shrink-0 text-zinc-600" strokeWidth={2} />
              {timelineLabel}
            </span>
            {decodeUsesProxy ? (
              <span
                className="inline-flex shrink-0 items-center gap-0.5 rounded border border-emerald-900/55 bg-emerald-950/35 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-300/95"
                title={`Decode path: ${engineMedia?.preview_decode_path ?? ""}`}
              >
                <RefreshCw className="h-2.5 w-2.5" strokeWidth={2} />
                Proxy
              </span>
            ) : null}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[11px] text-zinc-600">
            <Video className="h-3.5 w-3.5 text-zinc-700" strokeWidth={2} />
            {mediaHint ? "No timeline preview path" : "Waiting for engine…"}
          </span>
        )}
        {loading ? (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-600" strokeWidth={2} />
            Decoding
          </span>
        ) : null}
      </div>

      {mediaHint ? (
        <div className="flex max-w-xl items-start gap-2 rounded-md border border-amber-900/40 bg-amber-950/20 px-3 py-2 text-left text-[11px] text-amber-100/90">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" strokeWidth={2} />
          <span>{mediaHint}</span>
        </div>
      ) : null}

      {videoPath ? (
        <div className="flex w-full max-w-3xl flex-col gap-1 px-2">
          <input
            type="range"
            min={0}
            max={playbackSliderMax}
            step={0.01}
            value={Math.min(seekSeconds, playbackSliderMax)}
            onChange={(e) => onPlayheadTicksChange(secondsToTicksApprox(Number(e.target.value)))}
            className="w-full accent-zinc-400"
            aria-label="Preview time"
          />
          <div className="flex justify-between font-mono text-[10px] text-zinc-500">
            <span>{formatTime(seekSeconds)}</span>
            <span>{formatTime(playbackSliderMax)}</span>
          </div>
        </div>
      ) : null}

      {decodeError ? (
        <div className="flex max-w-xl items-start gap-2 rounded-md border border-red-900/50 bg-red-950/30 px-3 py-2 text-left text-xs text-red-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400/90" strokeWidth={2} />
          <span>{decodeError}</span>
        </div>
      ) : null}

      {gpuWindowError ? (
        <div className="flex max-w-xl items-start gap-2 rounded-md border border-red-900/40 bg-red-950/25 px-3 py-2 text-left text-[11px] text-red-200/95">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400/90" strokeWidth={2} />
          <span>{gpuWindowError}</span>
        </div>
      ) : null}

      <div className="flex min-h-0 w-full flex-1 items-center justify-center px-1 pb-1">
        <div className="aspect-video max-h-full w-full max-w-5xl overflow-hidden rounded-lg border border-zinc-800/70 bg-black shadow-inner ring-1 ring-zinc-950/80">
          {dataUrl ? (
            <img src={dataUrl} alt="Video preview frame" className="h-full w-full object-contain" />
          ) : (
            <div className="grid h-full min-h-[140px] place-items-center gap-2 px-4 text-center text-[11px] text-zinc-600">
              {!videoPath ? (
                project.head ? (
                  <>
                    <FolderOpen className="h-8 w-8 text-zinc-700" strokeWidth={1.25} />
                    <span>Import media or browse for a file.</span>
                  </>
                ) : (
                  <>
                    <Film className="h-8 w-8 text-zinc-700" strokeWidth={1.25} />
                    <span>Create or open a project first.</span>
                  </>
                )
              ) : loading ? (
                <>
                  <Loader2 className="h-7 w-7 animate-spin text-zinc-600" strokeWidth={2} />
                  <span>Loading frame…</span>
                </>
              ) : (
                <>
                  <Video className="h-8 w-8 text-zinc-700" strokeWidth={1.25} />
                  <span>Move the scrubber or wait for decode.</span>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
