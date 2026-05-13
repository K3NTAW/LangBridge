import { describe, expect, it } from "vitest";

import { buildFcpxml, rangesFromRenderResult } from "./fcpxml";
import { TICKS_PER_SECOND } from "./time";

describe("rangesFromRenderResult", () => {
  it("converts engine ticks to seconds", () => {
    const tps = Number(TICKS_PER_SECOND);
    const ranges = rangesFromRenderResult([
      { start_ticks: 0, end_ticks: tps }, // 0 → 1s
      { start_ticks: 2 * tps, end_ticks: 3.5 * tps }, // 2 → 3.5s
    ]);
    expect(ranges).toEqual([
      { startSecs: 0, endSecs: 1 },
      { startSecs: 2, endSecs: 3.5 },
    ]);
  });
});

describe("buildFcpxml", () => {
  it("emits a well-formed document with one clip per range", () => {
    const xml = buildFcpxml({
      sourcePath: "/Users/u/videos/clip.mp4",
      sourceDurationSecs: 60,
      frameRate: 30,
      width: 1920,
      height: 1080,
      ranges: [
        { startSecs: 0, endSecs: 1 },
        { startSecs: 2, endSecs: 4 },
      ],
    });
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain("<fcpxml version=\"1.10\">");
    // Two asset-clips, packed contiguously on the timeline.
    expect(xml.match(/<asset-clip /g)?.length).toBe(2);
    // First clip starts at timeline offset 0, source 0, duration 1s.
    expect(xml).toContain('offset="0/30s" start="0/30s" duration="30/30s"');
    // Second clip is offset by the first's duration (1s = 30/30).
    expect(xml).toContain('offset="30/30s" start="60/30s" duration="60/30s"');
    // File URL is encoded.
    expect(xml).toContain("file:///Users/u/videos/clip.mp4");
  });

  it("uses NTSC-fractional timebase when the fps is 29.97", () => {
    const xml = buildFcpxml({
      sourcePath: "/v.mp4",
      sourceDurationSecs: 10,
      frameRate: 29.97,
      ranges: [{ startSecs: 0, endSecs: 1 }],
    });
    // 29.97 fps → 30000/1001 s per frame, 1s = 30 frames * 1001 / 30000.
    expect(xml).toContain('frameDuration="1001/30000s"');
    expect(xml).toContain('duration="30030/30000s"');
  });

  it("percent-encodes paths with spaces in the file URL", () => {
    const xml = buildFcpxml({
      sourcePath: "/Users/u/My Videos/clip 2.mp4",
      sourceDurationSecs: 5,
      frameRate: 30,
      ranges: [{ startSecs: 0, endSecs: 1 }],
    });
    expect(xml).toContain(
      "file:///Users/u/My%20Videos/clip%202.mp4",
    );
  });
});
