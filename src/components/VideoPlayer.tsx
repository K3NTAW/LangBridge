/**
 * VideoPlayer — center-stage player for the active source.
 *
 * Uses the design-system .player-strip + .player-stage classes from
 * index.css. Source loads via Tauri's asset protocol (convertFileSrc),
 * which streams from disk — no JS heap copy of multi-GB sources.
 *
 * Native `<video controls>` is *not* used — we render a custom
 * transport bar so the chrome matches the rest of the app. Keyboard
 * shortcuts (space / ←→ / m / f / etc.) are also wired here.
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  FastForward,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Rewind,
  Video,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

interface Props {
  /** Absolute path to the source video, or null when no video is active. */
  sourcePath: string | null;
  /** Optional caption shown to the right of the filename (e.g. "23 edits applied"). */
  statusCaption?: string | null;
  /** When true, display the "Cut preview" badge over the stage. */
  cutMode?: boolean;
  /** Number of edits applied — shown in the cut badge. */
  editCount?: number;
  /** Notified once <video> reports its intrinsic resolution. */
  onResolutionDetected?: (width: number, height: number) => void;
  /**
   * When false, the player's keyboard shortcuts are inert. Used to
   * gate them when the Transcript tab is active so space-to-play
   * doesn't fire while the user is editing the transcript.
   */
  active?: boolean;
}

/**
 * Map (width, height) → a short label like "1080p" or "4K".
 * Picks the closest standard tier by short edge, since portrait
 * sources still get classified by height.
 */
function resolutionLabel(width: number, height: number): string {
  const shortEdge = Math.min(width, height);
  if (shortEdge >= 2000) return "4K";
  if (shortEdge >= 1300) return "1440p";
  if (shortEdge >= 1000) return "1080p";
  if (shortEdge >= 650) return "720p";
  if (shortEdge >= 440) return "480p";
  return "360p";
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i === -1 ? p : p.slice(i + 1);
}

/** Format `seconds` as `M:SS` (or `H:MM:SS` past one hour). */
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

/**
 * True if the keyboard event originated in a text-entry surface — we
 * skip playback shortcuts in those cases so the user can type freely.
 */
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

export function VideoPlayer({
  sourcePath,
  statusCaption,
  cutMode = false,
  editCount = 0,
  onResolutionDetected,
  active = true,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const scrubberRef = useRef<HTMLDivElement | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resolution, setResolution] = useState<{ w: number; h: number } | null>(null);

  // Transport state — mirrors the <video> element so the custom UI
  // can react to play/pause/seek/volume changes from anywhere
  // (keyboard, click on the video itself, etc.).
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // While the user is dragging the scrubber thumb we display this
  // pending time instead of the real currentTime — that way the
  // playhead doesn't jitter back to the engine's reported time on
  // every pointermove.
  const [scrubPending, setScrubPending] = useState<number | null>(null);
  // True between a `seeking` event and the matching `seeked`. We use
  // this both to dim the playhead UI (so it's clear the frame is
  // loading) and to suppress timeupdate writes that would otherwise
  // race ahead of the real frame.
  const [isSeeking, setIsSeeking] = useState(false);

  const assetUrl = useMemo(() => {
    if (!sourcePath) return null;
    try {
      return convertFileSrc(sourcePath);
    } catch {
      return null;
    }
  }, [sourcePath]);

  // Reset transport + error + resolution when the source changes so
  // we don't keep stale data from the previous clip.
  const onVideoLoadStart = useCallback(() => {
    setErrorMessage(null);
    setResolution(null);
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    setScrubPending(null);
    setIsSeeking(false);
  }, []);

  const onLoadedMetadata = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    const w = v.videoWidth;
    const h = v.videoHeight;
    if (w && h) {
      setResolution({ w, h });
      onResolutionDetected?.(w, h);
    }
    if (Number.isFinite(v.duration)) setDuration(v.duration);
  }, [onResolutionDetected]);

  const onVideoError = useCallback(() => {
    const v = videoRef.current;
    const err = v?.error;
    let msg = "Couldn't play this file.";
    if (err) {
      const codes: Record<number, string> = {
        1: "MEDIA_ERR_ABORTED — playback was aborted.",
        2: "MEDIA_ERR_NETWORK — couldn't fetch the file (asset protocol issue?).",
        3: "MEDIA_ERR_DECODE — file decoded but is corrupt or unsupported.",
        4: "MEDIA_ERR_SRC_NOT_SUPPORTED — codec or container not playable in WebView.",
      };
      msg = codes[err.code] ?? msg;
      if (err.message) msg += ` (${err.message})`;
    }
    setErrorMessage(msg);
    console.error("[sift] <video> error:", { sourcePath, assetUrl, error: err });
  }, [sourcePath, assetUrl]);

  // ── Transport actions ─────────────────────────────────────────────
  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused || v.ended) {
      v.play().catch((e) => {
        console.warn("[sift] play() rejected:", e);
      });
    } else {
      v.pause();
    }
  }, []);

  const seekTo = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    const clamped = Math.max(0, Math.min(v.duration || 0, t));
    // Optimistic playhead update so the UI snaps immediately.
    setCurrentTime(clamped);
    // WebKit's media stack can advance `currentTime` and keep firing
    // `timeupdate` while the displayed frame is still stuck at the
    // pre-seek position (the decoder hasn't loaded the new keyframe
    // yet). Pausing around the seek and only resuming on `seeked`
    // forces the frame to actually update before playback continues.
    const wasPlaying = !v.paused && !v.ended;
    if (wasPlaying) {
      v.pause();
      const onSeeked = () => {
        v.removeEventListener("seeked", onSeeked);
        v.play().catch((e) => console.warn("[sift] resume after seek failed:", e));
      };
      v.addEventListener("seeked", onSeeked, { once: true });
    }
    v.currentTime = clamped;
  }, []);

  const skipBy = useCallback(
    (delta: number) => {
      const v = videoRef.current;
      if (!v) return;
      seekTo((v.currentTime || 0) + delta);
    },
    [seekTo],
  );

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
  }, []);

  const changeVolume = useCallback((delta: number) => {
    const v = videoRef.current;
    if (!v) return;
    const next = Math.max(0, Math.min(1, (v.volume ?? 0) + delta));
    v.volume = next;
    if (next > 0 && v.muted) v.muted = false;
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void el.requestFullscreen().catch((e) => {
        console.warn("[sift] requestFullscreen rejected:", e);
      });
    }
  }, []);

  // Sync `isFullscreen` with the actual document state — covers Esc
  // exits and OS-level fullscreen transitions we didn't initiate.
  useEffect(() => {
    function onFsChange() {
      setIsFullscreen(document.fullscreenElement === stageRef.current);
    }
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  // ── Scrubber drag ────────────────────────────────────────────────
  const scrubFromPointer = useCallback(
    (clientX: number): number | null => {
      const track = scrubberRef.current;
      const v = videoRef.current;
      if (!track || !v || !v.duration || !Number.isFinite(v.duration)) return null;
      const rect = track.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return fraction * v.duration;
    },
    [],
  );

  const onScrubberPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      const t = scrubFromPointer(e.clientX);
      if (t !== null) {
        setScrubPending(t);
      }
    },
    [scrubFromPointer],
  );

  const onScrubberPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      const t = scrubFromPointer(e.clientX);
      if (t !== null) setScrubPending(t);
    },
    [scrubFromPointer],
  );

  const onScrubberPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const t = scrubFromPointer(e.clientX);
      try {
        (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
      } catch {
        /* capture may already be released */
      }
      if (t !== null) seekTo(t);
      setScrubPending(null);
    },
    [scrubFromPointer, seekTo],
  );

  // ── Keyboard shortcuts ───────────────────────────────────────────
  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      // Don't trap keys when the user is typing in a form.
      if (isTextEntryTarget(e.target)) return;
      // Modifier keys are reserved for app-level shortcuts (⌘B, etc.).
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const v = videoRef.current;
      if (!v) return;

      switch (e.key) {
        case " ":
        case "k":
        case "K":
          e.preventDefault();
          togglePlay();
          return;
        case "ArrowLeft":
          e.preventDefault();
          skipBy(e.shiftKey ? -1 : -10);
          return;
        case "ArrowRight":
          e.preventDefault();
          skipBy(e.shiftKey ? 1 : 10);
          return;
        case "j":
        case "J":
          e.preventDefault();
          skipBy(-10);
          return;
        case "l":
        case "L":
          e.preventDefault();
          skipBy(10);
          return;
        case "ArrowUp":
          e.preventDefault();
          changeVolume(0.05);
          return;
        case "ArrowDown":
          e.preventDefault();
          changeVolume(-0.05);
          return;
        case "m":
        case "M":
          e.preventDefault();
          toggleMute();
          return;
        case "f":
        case "F":
          e.preventDefault();
          toggleFullscreen();
          return;
        case "Home":
          e.preventDefault();
          seekTo(0);
          return;
        case "End":
          e.preventDefault();
          if (Number.isFinite(v.duration)) seekTo(v.duration);
          return;
      }

      // Number keys 0–9 → seek to that decile (YouTube convention).
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        if (Number.isFinite(v.duration)) {
          const frac = Number.parseInt(e.key, 10) / 10;
          seekTo(v.duration * frac);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, togglePlay, skipBy, seekTo, changeVolume, toggleMute, toggleFullscreen]);

  if (!sourcePath) {
    return (
      <div className="empty">
        <div className="icon-wrap">
          <Video size={20} strokeWidth={1.75} />
        </div>
        <div className="empty-headline">Pick a video to start</div>
        <div className="empty-sub">
          Choose a clip in the folder pane on the left. Sift will load it here and begin
          transcribing.
        </div>
      </div>
    );
  }

  const displayedTime = scrubPending !== null ? scrubPending : currentTime;
  const progressFraction =
    duration > 0 && Number.isFinite(duration) ? Math.min(1, displayedTime / duration) : 0;
  const progressPct = `${(progressFraction * 100).toFixed(2)}%`;

  return (
    <>
      <div className="player-strip">
        {cutMode ? (
          <>
            <span className="file">current cut</span>
            <span className="sep">·</span>
            <span className="meta">{editCount} edits applied</span>
          </>
        ) : (
          <>
            <span className="file t-mono">{basename(sourcePath)}</span>
            <span className="sep">·</span>
            <span className="meta">{statusCaption ?? "original"}</span>
          </>
        )}
        {resolution ? (
          <>
            <span className="sep">·</span>
            <span
              className="meta t-mono"
              title={`${resolution.w} × ${resolution.h}`}
            >
              {resolutionLabel(resolution.w, resolution.h)} ({resolution.w}×{resolution.h})
            </span>
          </>
        ) : null}
      </div>
      <div className="player-stage" ref={stageRef}>
        {cutMode ? (
          <div className="cut-badge">
            <span className="dot" />
            <span>Cut preview · {editCount} edits</span>
          </div>
        ) : null}
        <div className="player-canvas">
          {assetUrl ? (
            <video
              ref={videoRef}
              key={assetUrl}
              src={assetUrl}
              playsInline
              preload="metadata"
              onLoadStart={onVideoLoadStart}
              onLoadedMetadata={onLoadedMetadata}
              onError={onVideoError}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onSeeking={() => setIsSeeking(true)}
              onSeeked={() => setIsSeeking(false)}
              onTimeUpdate={(e) => {
                // Don't believe `currentTime` while the user is
                // scrubbing (their drag drives the playhead) or while
                // the decoder is mid-seek (WebKit can report the
                // target time before the frame is actually loaded,
                // which is what makes the timeline "run ahead" of
                // the still-stuck video).
                if (scrubPending !== null || isSeeking) return;
                setCurrentTime((e.currentTarget as HTMLVideoElement).currentTime);
              }}
              onDurationChange={(e) => {
                const d = (e.currentTarget as HTMLVideoElement).duration;
                if (Number.isFinite(d)) setDuration(d);
              }}
              onVolumeChange={(e) => {
                const v = e.currentTarget as HTMLVideoElement;
                setIsMuted(v.muted);
                setVolume(v.volume);
              }}
              onClick={togglePlay}
            />
          ) : null}
          {errorMessage ? (
            <div role="alert" className="player-error">
              <AlertTriangle size={14} strokeWidth={2} className="player-error-icon" />
              <div>
                <div className="player-error-title">Playback failed</div>
                <div className="player-error-sub">{errorMessage}</div>
                <div className="player-error-path" title={sourcePath ?? ""}>
                  {sourcePath}
                </div>
              </div>
            </div>
          ) : null}
        </div>
        <div className="transport-bar">
          <button
            type="button"
            className="transport-btn transport-skip"
            onClick={() => skipBy(-10)}
            title="Back 10 seconds (←)"
            aria-label="Back 10 seconds"
          >
            <Rewind size={14} strokeWidth={2} />
            <span className="transport-skip-label">10</span>
          </button>
          <button
            type="button"
            className="transport-btn"
            onClick={togglePlay}
            title={isPlaying ? "Pause (Space)" : "Play (Space)"}
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? (
              <Pause size={14} strokeWidth={2} />
            ) : (
              <Play size={14} strokeWidth={2} />
            )}
          </button>
          <button
            type="button"
            className="transport-btn transport-skip"
            onClick={() => skipBy(10)}
            title="Forward 10 seconds (→)"
            aria-label="Forward 10 seconds"
          >
            <span className="transport-skip-label">10</span>
            <FastForward size={14} strokeWidth={2} />
          </button>
          <div
            ref={scrubberRef}
            className={`transport-scrubber${scrubPending !== null ? " is-dragging" : ""}`}
            onPointerDown={onScrubberPointerDown}
            onPointerMove={onScrubberPointerMove}
            onPointerUp={onScrubberPointerUp}
            onPointerCancel={onScrubberPointerUp}
            role="slider"
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={duration || 0}
            aria-valuenow={displayedTime}
          >
            <div className="transport-scrubber-track" />
            <div className="transport-scrubber-fill" style={{ width: progressPct }} />
            <div className="transport-scrubber-thumb" style={{ left: progressPct }} />
          </div>
          <span className="transport-time">
            {formatTime(displayedTime)} / {formatTime(duration)}
          </span>
          <button
            type="button"
            className="transport-btn"
            onClick={toggleMute}
            title={isMuted || volume === 0 ? "Unmute (M)" : "Mute (M)"}
            aria-label={isMuted || volume === 0 ? "Unmute" : "Mute"}
          >
            {isMuted || volume === 0 ? (
              <VolumeX size={14} strokeWidth={2} />
            ) : (
              <Volume2 size={14} strokeWidth={2} />
            )}
          </button>
          <button
            type="button"
            className="transport-btn"
            onClick={toggleFullscreen}
            title={isFullscreen ? "Exit fullscreen (F)" : "Fullscreen (F)"}
            aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {isFullscreen ? (
              <Minimize2 size={14} strokeWidth={2} />
            ) : (
              <Maximize2 size={14} strokeWidth={2} />
            )}
          </button>
        </div>
      </div>
    </>
  );
}
