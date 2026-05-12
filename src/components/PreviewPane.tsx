/**
 * Preview pane — Sift v0.
 *
 * Plays the latest flattened-cut MP4 produced by the segment-cache renderer
 * (see `lib/previewRender.ts`). Native HTML5 `<video>` controls. No
 * `convertFileSrc` / asset-protocol gymnastics — the renderer writes the
 * file under the project's `.sift/cache/` directory and we hand its path
 * to the `<video>` element directly.
 *
 * No global playhead. No frame-accurate scrub. No timeline. The chat panel
 * and the transcript are how the user navigates.
 */
import { Film, Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";

interface Props {
  /** Absolute path to the current preview MP4, or null when nothing is ready yet. */
  previewPath: string | null;
  /** True while the renderer is producing a new cut. Shows a subtle overlay. */
  rendering?: boolean;
}

export function PreviewPane({ previewPath, rendering = false }: Props) {
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
          src={`file://${previewPath}`}
          className="h-full w-full bg-black object-contain"
          controls
          playsInline
          preload="auto"
        />
      ) : (
        <div className="grid place-items-center gap-2 text-center text-[11px] text-zinc-600">
          <Film className="h-8 w-8 text-zinc-700" strokeWidth={1.25} />
          <span>Open a folder to start editing.</span>
        </div>
      )}

      {rendering ? (
        <div className="pointer-events-none absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900/80 px-2 py-1 text-[10px] font-medium text-zinc-300 shadow">
          <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
          Rendering preview…
        </div>
      ) : null}
    </div>
  );
}
