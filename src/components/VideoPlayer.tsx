/**
 * VideoPlayer — center-stage player for the active source.
 *
 * Uses the design-system .player-strip + .player-stage classes from
 * index.css. Source loads via Tauri's asset protocol (convertFileSrc),
 * which streams from disk — no JS heap copy of multi-GB sources.
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import { AlertTriangle, Video } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

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

export function VideoPlayer({
  sourcePath,
  statusCaption,
  cutMode = false,
  editCount = 0,
  onResolutionDetected,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resolution, setResolution] = useState<{ w: number; h: number } | null>(null);

  const assetUrl = useMemo(() => {
    if (!sourcePath) return null;
    try {
      return convertFileSrc(sourcePath);
    } catch {
      return null;
    }
  }, [sourcePath]);

  // Reset error + resolution when the source changes so we don't keep stale data.
  const onVideoLoadStart = useCallback(() => {
    setErrorMessage(null);
    setResolution(null);
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
    // Also log so the dev console has the full details
    console.error("[sift] <video> error:", { sourcePath, assetUrl, error: err });
  }, [sourcePath, assetUrl]);

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
      <div className="player-stage">
        {cutMode ? (
          <div className="cut-badge">
            <span className="dot" />
            <span>Cut preview · {editCount} edits</span>
          </div>
        ) : null}
        {assetUrl ? (
          <video
            ref={videoRef}
            key={assetUrl}
            src={assetUrl}
            controls
            playsInline
            preload="metadata"
            onLoadStart={onVideoLoadStart}
            onLoadedMetadata={onLoadedMetadata}
            onError={onVideoError}
          />
        ) : null}
        {errorMessage ? (
          <div
            role="alert"
            style={{
              position: "absolute",
              left: 14,
              right: 14,
              bottom: 14,
              padding: "10px 12px",
              background: "rgba(20,15,10,0.85)",
              backdropFilter: "blur(8px)",
              border: "1px solid var(--accent-danger)",
              borderRadius: "var(--r-sm)",
              color: "var(--fg)",
              fontSize: 12,
              lineHeight: 1.45,
              display: "flex",
              gap: 8,
              alignItems: "flex-start",
              zIndex: 3,
            }}
          >
            <AlertTriangle
              size={14}
              strokeWidth={2}
              style={{ color: "var(--accent-danger)", flex: "0 0 auto", marginTop: 1 }}
            />
            <div>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>Playback failed</div>
              <div style={{ color: "var(--fg-muted)" }}>{errorMessage}</div>
              <div
                style={{
                  marginTop: 6,
                  fontFamily: "var(--font-mono)",
                  fontSize: 10.5,
                  color: "var(--fg-subtle)",
                }}
                title={sourcePath ?? ""}
              >
                {sourcePath}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}
