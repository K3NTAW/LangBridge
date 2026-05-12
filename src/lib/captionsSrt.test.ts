import { describe, expect, it } from "vitest";

import type { TranscriptWord } from "./aiClient";
import type { RenderRange } from "./engineClient";
import {
  buildCaptionsSrtFromWords,
  sourcePointToOutputTick,
  suggestCaptionsPath,
  ticksToSrtTimestamp,
  DEFAULT_CAPTION_OPTIONS,
} from "./captionsSrt";
import { TICKS_PER_SECOND } from "./time";

describe("ticksToSrtTimestamp", () => {
  it("formats zero", () => {
    expect(ticksToSrtTimestamp(0n)).toBe("00:00:00,000");
  });

  it("formats one second", () => {
    expect(ticksToSrtTimestamp(TICKS_PER_SECOND)).toBe("00:00:01,000");
  });

  it("formats fractional second", () => {
    const half = TICKS_PER_SECOND / 2n;
    expect(ticksToSrtTimestamp(half)).toBe("00:00:00,500");
  });
});

function word(startSec: number, endSec: number, text: string): TranscriptWord {
  const tps = Number(TICKS_PER_SECOND);
  return {
    start_ticks: Math.round(startSec * tps),
    end_ticks: Math.round(endSec * tps),
    word: text,
    probability: 1,
  };
}

describe("suggestCaptionsPath", () => {
  it("replaces extension with .captions.srt", () => {
    expect(suggestCaptionsPath("/tmp/foo/bar.mp4")).toBe("/tmp/foo/bar.captions.srt");
  });

  it("appends when no extension", () => {
    expect(suggestCaptionsPath("/tmp/clip")).toBe("/tmp/clip.captions.srt");
  });
});

describe("sourcePointToOutputTick", () => {
  const rr = (a: number, b: number): RenderRange => ({
    source_id: "s",
    start_ticks: Math.round(a * Number(TICKS_PER_SECOND)),
    end_ticks: Math.round(b * Number(TICKS_PER_SECOND)),
  });

  it("maps inside first span", () => {
    const ranges = [rr(0, 1)];
    expect(sourcePointToOutputTick(BigInt(Math.round(0.5 * Number(TICKS_PER_SECOND))), ranges)).toBe(
      BigInt(Math.round(0.5 * Number(TICKS_PER_SECOND))),
    );
  });

  it("accumulates prior spans", () => {
    const ranges = [rr(0, 0.2), rr(3, 3.5)];
    const midSecond = BigInt(Math.round(3.25 * Number(TICKS_PER_SECOND)));
    const expected =
      BigInt(Math.round(0.2 * Number(TICKS_PER_SECOND))) + BigInt(Math.round(0.25 * Number(TICKS_PER_SECOND)));
    expect(sourcePointToOutputTick(midSecond, ranges)).toBe(expected);
  });
});

describe("buildCaptionsSrtFromWords export remap", () => {
  it("uses output timeline when ranges provided", () => {
    const wA = word(0, 0.2, "a");
    const wB = word(3.0, 3.3, "b");
    const ranges = [
      { source_id: "s", start_ticks: wA.start_ticks, end_ticks: wA.end_ticks },
      { source_id: "s", start_ticks: wB.start_ticks, end_ticks: wB.end_ticks },
    ];
    const srt = buildCaptionsSrtFromWords([wA, wB], new Set(), { ...DEFAULT_CAPTION_OPTIONS, maxWordsPerCue: 1 }, ranges);
    expect(srt).toContain("a");
    expect(srt).toContain("b");
    expect(srt).not.toContain("00:00:03,");
    const blocks = srt.trim().split(/\n\n+/).filter(Boolean);
    expect(blocks.length).toBe(2);
    const secondCueTimeLine = blocks[1]?.split("\n")[1] ?? "";
    expect(secondCueTimeLine.startsWith("00:00:00,")).toBe(true);
  });
});

describe("buildCaptionsSrtFromWords", () => {
  it("returns empty string when nothing kept", () => {
    const words = [word(0, 0.5, "hi")];
    expect(buildCaptionsSrtFromWords(words, new Set([0]))).toBe("");
  });

  it("emits one cue for one word", () => {
    const words = [word(0, 0.5, "Hello")];
    const srt = buildCaptionsSrtFromWords(words, new Set());
    expect(srt).toContain("1\n");
    expect(srt).toContain("-->");
    expect(srt).toContain("Hello");
  });

  it("skips deleted indices", () => {
    const words = [word(0, 0.2, "a"), word(0.2, 0.4, "b"), word(0.4, 0.6, "c")];
    const srt = buildCaptionsSrtFromWords(words, new Set([1]));
    expect(srt).toContain("a");
    expect(srt).not.toContain("b");
    expect(srt).toContain("c");
  });

  it("starts new cue after long gap", () => {
    const words = [
      word(0, 0.3, "one"),
      word(3.0, 3.3, "two"), // 2.7s gap >> default 0.5s
    ];
    const srt = buildCaptionsSrtFromWords(words, new Set(), {
      ...DEFAULT_CAPTION_OPTIONS,
      gapTicksNewCue: TICKS_PER_SECOND / 2n,
    });
    const blocks = srt.split(/\n\n+/).filter(Boolean);
    expect(blocks.length).toBe(2);
    expect(blocks[0]).toContain("one");
    expect(blocks[1]).toContain("two");
  });
});
