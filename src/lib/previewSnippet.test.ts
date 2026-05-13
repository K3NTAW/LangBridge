import { describe, expect, it } from "vitest";

import { computeSnippetRangesAfterDeletes } from "./previewSnippet";
import { TICKS_PER_SECOND } from "./time";
import type { TranscriptState } from "./transcriptOps";

const TPS = Number(TICKS_PER_SECOND);
const sec = (n: number): number => Math.round(n * TPS);

function makeState(opts: {
  words: { start: number; end: number }[];
  deleted?: number[];
}): TranscriptState {
  return {
    transcript: {
      source_id: "src",
      language: "en",
      segments: [],
      words: opts.words.map((w) => ({
        word: "w",
        start_ticks: sec(w.start),
        end_ticks: sec(w.end),
        probability: 1,
      })),
    },
    ingest: {
      wordToClipId: new Map(opts.words.map((_, i) => [i, `c${i}`])),
      wordToTimelineAt: new Map(opts.words.map((_, i) => [i, i * 100])),
    },
    deleted: new Set(opts.deleted ?? []),
    sourcePath: "/x.mp4",
  };
}

describe("computeSnippetRangesAfterDeletes", () => {
  it("returns an empty list when every word is filtered out", () => {
    const state = makeState({ words: [{ start: 0, end: 1 }], deleted: [0] });
    expect(computeSnippetRangesAfterDeletes(state, [], "/x.mp4")).toEqual([]);
  });

  it("merges adjacent words into a single range", () => {
    const state = makeState({
      words: [
        { start: 0, end: 1 },
        { start: 1.01, end: 2 }, // 10ms gap → merge
      ],
    });
    const ranges = computeSnippetRangesAfterDeletes(state, [], "/x.mp4");
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.src_in_secs).toBeCloseTo(0, 4);
    expect(ranges[0]!.src_out_secs).toBeCloseTo(2, 4);
  });

  it("splits when the gap exceeds the merge threshold", () => {
    const state = makeState({
      words: [
        { start: 0, end: 1 },
        { start: 2, end: 3 }, // 1s gap → don't merge
      ],
    });
    const ranges = computeSnippetRangesAfterDeletes(state, [], "/x.mp4");
    expect(ranges).toHaveLength(2);
    expect(ranges[0]!.src_in_secs).toBeCloseTo(0, 4);
    expect(ranges[0]!.src_out_secs).toBeCloseTo(1, 4);
    expect(ranges[1]!.src_in_secs).toBeCloseTo(2, 4);
    expect(ranges[1]!.src_out_secs).toBeCloseTo(3, 4);
  });

  it("excludes additionally-deleted words", () => {
    const state = makeState({
      words: [
        { start: 0, end: 1 },
        { start: 1, end: 2 },
        { start: 2, end: 3 },
      ],
    });
    const ranges = computeSnippetRangesAfterDeletes(state, [1], "/x.mp4");
    expect(ranges).toEqual([
      { source_path: "/x.mp4", src_in_secs: 0, src_out_secs: 1 },
      { source_path: "/x.mp4", src_in_secs: 2, src_out_secs: 3 },
    ]);
  });

  it("combines existing deleted + additional deletes", () => {
    const state = makeState({
      words: [
        { start: 0, end: 1 },
        { start: 1, end: 2 },
        { start: 2, end: 3 },
        { start: 3, end: 4 },
      ],
      deleted: [0], // user already removed word 0
    });
    const ranges = computeSnippetRangesAfterDeletes(state, [2], "/x.mp4");
    // kept: 1, 3 → ranges [1,2] and [3,4]
    expect(ranges).toEqual([
      { source_path: "/x.mp4", src_in_secs: 1, src_out_secs: 2 },
      { source_path: "/x.mp4", src_in_secs: 3, src_out_secs: 4 },
    ]);
  });

  it("caps the snippet at maxSecs, truncating the last range", () => {
    const state = makeState({
      words: [
        { start: 0, end: 5 },
        { start: 5, end: 20 },
      ],
    });
    const ranges = computeSnippetRangesAfterDeletes(state, [], "/x.mp4", {
      maxSecs: 8,
    });
    // After merge: one range 0..20. Capped to 8s → [0, 8].
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.src_in_secs).toBeCloseTo(0, 4);
    expect(ranges[0]!.src_out_secs).toBeCloseTo(8, 4);
  });

  it("respects maxSecs across multiple ranges", () => {
    const state = makeState({
      words: [
        { start: 0, end: 3 },
        { start: 5, end: 9 },
        { start: 20, end: 30 },
      ],
    });
    const ranges = computeSnippetRangesAfterDeletes(state, [], "/x.mp4", {
      maxSecs: 5,
    });
    // First range = 3s (used=3). Second range starts: remaining=2 → [5,7]. used=5. Stop.
    expect(ranges).toHaveLength(2);
    expect(ranges[0]!.src_out_secs).toBeCloseTo(3, 4);
    expect(ranges[1]!.src_in_secs).toBeCloseTo(5, 4);
    expect(ranges[1]!.src_out_secs).toBeCloseTo(7, 4);
  });

  it("skips zero-duration words", () => {
    const state = makeState({
      words: [
        { start: 0, end: 0 }, // zero
        { start: 0, end: 1 },
      ],
    });
    const ranges = computeSnippetRangesAfterDeletes(state, [], "/x.mp4");
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.src_in_secs).toBeCloseTo(0, 4);
    expect(ranges[0]!.src_out_secs).toBeCloseTo(1, 4);
  });
});
