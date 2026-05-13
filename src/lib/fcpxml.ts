/**
 * FCPXML export — a hand-off format for finishing in Final Cut Pro,
 * DaVinci Resolve, or Premiere. We emit FCPXML 1.10, which all three
 * NLEs read.
 *
 * v0 scope:
 *   - Single source clip (Sift's engine is single-source today; the
 *     multi-source variant lands with cross-video editing).
 *   - One sequence with the kept ranges placed contiguously on a
 *     single video track. Audio rides along with the video.
 *   - No effects, no markers, no audio levels. Anything the user
 *     added at the source level (in/out points) is preserved via
 *     the per-clip `start` + `duration` we emit.
 *
 * FCPXML uses *rational* time values: `<numerator>/<denominator>s`,
 * always in seconds, with a base timescale (e.g. `30000/1001s` for a
 * single 29.97 fps frame). To round-trip safely we pick a timebase
 * derived from the source frame rate and quantise all durations to
 * an integer number of frames at that rate. Off-frame cuts get
 * snapped to the nearest frame — fine for a hand-off; the source MP4
 * is what carries the actual frame data.
 */

import { TICKS_PER_SECOND } from "./time";

export interface FcpxmlRange {
  /** Source-time in seconds, inclusive start. */
  startSecs: number;
  /** Source-time in seconds, exclusive end. */
  endSecs: number;
}

export interface FcpxmlExportInput {
  /**
   * Absolute path to the source video on disk. We emit a `file://`
   * URL so finishing apps resolve it from the user's local disk.
   */
  sourcePath: string;
  /** Source duration in seconds. Used for the `<asset>` length. */
  sourceDurationSecs: number;
  /** Source frame rate (fps). 30 is a safe default when unknown. */
  frameRate: number;
  /** Source resolution in pixels. Optional but useful for hinting. */
  width?: number;
  height?: number;
  /**
   * Ranges that survive the cut, in source seconds. Should be
   * sorted ascending and non-overlapping. Use
   * `rangesFromRenderResult` to convert from the engine's tick output.
   */
  ranges: ReadonlyArray<FcpxmlRange>;
  /** Project name displayed in the finishing app. */
  projectName?: string;
}

/**
 * Convert an engine `RenderRangesResult.ranges` payload into the
 * second-typed shape FCPXML expects.
 */
export function rangesFromRenderResult(
  ranges: ReadonlyArray<{ start_ticks: number; end_ticks: number }>,
): FcpxmlRange[] {
  const tps = Number(TICKS_PER_SECOND);
  return ranges.map((r) => ({
    startSecs: r.start_ticks / tps,
    endSecs: r.end_ticks / tps,
  }));
}

/** Escape the few characters XML actually needs escaped in text/attrs. */
function xmlEscape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Build a `<URL>`-shaped `file://` reference for a local path. We
 * percent-encode the path components (but leave `/` alone) so
 * spaces, unicode, and other shell-friendly characters survive.
 */
function fileUrlFromPath(absPath: string): string {
  // macOS/Linux: starts with `/`. Windows: `C:\...` — convert
  // backslashes and prepend a leading `/`.
  let p = absPath.replace(/\\/g, "/");
  if (!p.startsWith("/")) p = `/${p}`;
  // Encode each segment so spaces, etc. survive.
  const encoded = p
    .split("/")
    .map((seg) => (seg === "" ? "" : encodeURIComponent(seg)))
    .join("/");
  return `file://${encoded}`;
}

/**
 * Express a duration in seconds as the rational FCPXML form
 * `numerator/denominator s`. We snap to the nearest frame and use
 * a `1001`-multiplied denominator when the fps is a NTSC fractional
 * rate (23.976, 29.97, 59.94) so the rationals stay exact.
 */
function rationalSecs(seconds: number, frameRate: number): string {
  const safeFps = frameRate > 0 && Number.isFinite(frameRate) ? frameRate : 30;
  // FCPXML's preferred timebase: pick a denominator that exactly
  // represents one frame. For 24000/1001, 30000/1001, 60000/1001
  // (NTSC fractional rates) we use the `1000`-multiple form.
  const isNtsc = isNtscFractional(safeFps);
  const denominator = isNtsc ? Math.round(safeFps * 1001) : Math.round(safeFps);
  const tbBase = isNtsc ? 1001 : 1; // ratio scalar
  // frames count, rounded to nearest
  const frames = Math.round(seconds * safeFps);
  const numerator = frames * tbBase;
  return `${numerator}/${denominator}s`;
}

function isNtscFractional(fps: number): boolean {
  const candidates = [23.976, 29.97, 59.94, 119.88];
  return candidates.some((c) => Math.abs(c - fps) < 0.01);
}

/** Timebase string used at the `<format>` element — same form as durations. */
function frameDurationString(frameRate: number): string {
  return rationalSecs(1 / frameRate, frameRate);
}

/**
 * Build the FCPXML document as a string.
 *
 * The doc has three pieces:
 *   1. `<resources>` — declares one `<format>` (frame rate / size)
 *      and one `<asset>` pointing at the source MP4.
 *   2. `<library><event><project>` — wrapper.
 *   3. `<sequence>` — contains a single `<spine>` with one
 *      `<asset-clip>` per kept range. Each `<asset-clip>` has a
 *      `start` (where on the timeline) and `duration` (length on
 *      the timeline) plus a `tcFormat="NDF"` flag.
 */
export function buildFcpxml(input: FcpxmlExportInput): string {
  const {
    sourcePath,
    sourceDurationSecs,
    frameRate,
    width,
    height,
    ranges,
    projectName = "Sift Cut",
  } = input;

  const fps = frameRate > 0 && Number.isFinite(frameRate) ? frameRate : 30;
  const frameDur = frameDurationString(fps);
  const assetDur = rationalSecs(sourceDurationSecs, fps);
  const fileUrl = fileUrlFromPath(sourcePath);
  const safeName = xmlEscape(projectName);
  const baseName =
    sourcePath
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.[^.]+$/, "") ?? "source";
  const assetId = "r2";
  const formatId = "r1";

  // Walk the ranges, accumulating timeline offset (start). Each clip's
  // `offset` is the running timeline position; `start` is the source
  // in-point.
  let timelineSecs = 0;
  const clipXml: string[] = [];
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i]!;
    const durSecs = Math.max(0, r.endSecs - r.startSecs);
    if (durSecs <= 0) continue;
    const offset = rationalSecs(timelineSecs, fps);
    const startSrc = rationalSecs(r.startSecs, fps);
    const duration = rationalSecs(durSecs, fps);
    clipXml.push(
      `      <asset-clip name="${xmlEscape(baseName)} ${i + 1}" ref="${assetId}" offset="${offset}" start="${startSrc}" duration="${duration}" tcFormat="NDF"/>`,
    );
    timelineSecs += durSecs;
  }

  const totalDuration = rationalSecs(timelineSecs, fps);
  const widthAttr = width && width > 0 ? ` width="${width}"` : "";
  const heightAttr = height && height > 0 ? ` height="${height}"` : "";

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE fcpxml>`,
    `<fcpxml version="1.10">`,
    `  <resources>`,
    `    <format id="${formatId}" name="FFVideoFormat${width ?? ""}p${Math.round(fps * 100)}" frameDuration="${frameDur}"${widthAttr}${heightAttr}/>`,
    `    <asset id="${assetId}" name="${xmlEscape(baseName)}" start="0s" duration="${assetDur}" hasVideo="1" hasAudio="1" format="${formatId}" audioSources="1" audioChannels="2" audioRate="48000">`,
    `      <media-rep kind="original-media" src="${xmlEscape(fileUrl)}"/>`,
    `    </asset>`,
    `  </resources>`,
    `  <library>`,
    `    <event name="${safeName}">`,
    `      <project name="${safeName}">`,
    `        <sequence format="${formatId}" duration="${totalDuration}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">`,
    `          <spine>`,
    ...clipXml,
    `          </spine>`,
    `        </sequence>`,
    `      </project>`,
    `    </event>`,
    `  </library>`,
    `</fcpxml>`,
    "",
  ].join("\n");
}
