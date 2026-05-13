/**
 * Preview pane — Sift v0.
 *
 * Plays the latest flattened-cut MP4 produced by the preview renderer
 * (`lib/previewRender.ts`). `src` is a Blob URL handed in from App.tsx,
 * NOT a `file://` path — that way we don't need the Tauri asset
 * protocol enabled (which previously fought with the dialog plugin).
 *
 * No global playhead. No frame-accurate scrub. No timeline. The chat
 * panel and the transcript are how the user navigates.
 */
import { Film, Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";

interface Props {
  /** Blob URL of the current preview MP4, or null when nothing is ready yet. */
  previewPath: string | null;
  /** True while the renderer is producing a new cut. Shows a subtle overlay. */
  rendering?: boolean;
  /** Last error from the preview renderer, surfaced in-pane. */
  error?: string | null;
}

export function PreviewPane({ previewPath, rendering = false, error = null }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // When the preview file changes, ask the element to reload — same `<video>`
  // node, new src, fresh metadata.
  useEffect(() => {
    const v = videoRef.current;
    if (v && previewPath) {
      v.load();
    }
  }, [previewPath]);

  return (
    <div className="relative flex h-full w-full items-center justify-center bg-black">
      {previewPath ? (
        <video
          ref={videoRef}
          src={previewPath}
          className="h-full w-full bg-black object-contain"
          controls
          playsInline
          preload="auto"
        />
      ) : (
        <div className="grid place-items-center gap-2 px-6 text-center text-[11px] text-zinc-600">
          <Film className="h-8 w-8 text-zinc-700" strokeWidth={1.25} />
          <span>
            {rendering
              ? "Rendering preview…"
              : error
                ? "Preview unavailable"
                : "Open a folder and make an edit to see the cut here."}
          </span>
        </div>
      )}

      {rendering ? (
        <div className="pointer-events-none absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900/80 px-2 py-1 text-[10px] font-medium text-zinc-300 shadow">
          <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
          Rendering preview…
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="absolute bottom-3 left-3 right-3 max-w-md rounded-md border border-amber-900/45 bg-amber-950/85 px-2.5 py-2 text-[11px] text-amber-100/95 shadow"
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
