import { describe, expect, it } from "vitest";

import {
  classifyIntent,
  parseTimeRange,
  parseTimestamp,
  planFromUserPrompt,
} from "./stubPlanner";
import type { TranscriptState } from "./transcriptOps";
import { TICKS_PER_SECOND } from "./time";

const FILLER_TRANSCRIPT: TranscriptState = {
  transcript: {
    source_id: "src-test",
    language: "en",
    segments: [],
    words: [
      { word: "Hello", start_ticks: 0, end_ticks: 1, probability: 0.9 },
      { word: "um", start_ticks: 1, end_ticks: 2, probability: 0.9 },
      { word: "world", start_ticks: 2, end_ticks: 3, probability: 0.9 },
      { word: "uh", start_ticks: 3, end_ticks: 4, probability: 0.9 },
    ],
  },
  deleted: new Set<number>(),
  ingest: {
    wordToClipId: new Map<number, string>([
      [0, "clip-a"],
      [1, "clip-b"],
      [2, "clip-c"],
      [3, "clip-d"],
    ]),
    wordToTimelineAt: new Map<number, number>([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ]),
  },
};

const CLEAN_TRANSCRIPT: TranscriptState = {
  transcript: {
    source_id: "src-test",
    language: "en",
    segments: [],
    words: [
      { word: "Hello", start_ticks: 0, end_ticks: 1, probability: 0.9 },
      { word: "world", start_ticks: 1, end_ticks: 2, probability: 0.9 },
    ],
  },
  deleted: new Set<number>(),
  ingest: {
    wordToClipId: new Map<number, string>([
      [0, "clip-a"],
      [1, "clip-b"],
    ]),
    wordToTimelineAt: new Map<number, number>([
      [0, 0],
      [1, 1],
    ]),
  },
};

describe("classifyIntent", () => {
  it("recognises filler-cut intents in many forms", () => {
    for (const phrase of [
      "cut the fillers",
      "remove fillers",
      "cut fillers",
      "drop the fillers",
      "cut the ums",
      "Remove Filler Words",
      "auto-clean",
      "kill the hmms",
    ]) {
      expect(classifyIntent(phrase)).toBe("cut_fillers");
    }
  });

  it("recognises silence-cut intents", () => {
    for (const phrase of [
      "cut the silences",
      "remove silence",
      "trim the silent parts",
      "silence strip",
      "strip silence",
    ]) {
      expect(classifyIntent(phrase)).toBe("cut_silences");
    }
  });

  it("returns unknown for arbitrary prompts", () => {
    for (const phrase of [
      "make it more entertaining",
      "tighten the intro",
      "hello",
      "",
      "   ",
    ]) {
      expect(classifyIntent(phrase)).toBe("unknown");
    }
  });

  it("recognises time-range cuts in many forms", () => {
    for (const phrase of [
      "cut 2:23 to 3:45",
      "drop from 1:10 to 1:30",
      "remove between 0:45 and 1:00",
      "trim 1:00 → 1:10",
      "delete 0:30-0:45",
      "Cut From 5:00 Until 5:10",
    ]) {
      expect(classifyIntent(phrase)).toBe("cut_range");
    }
  });

  it("doesn't classify time mentions without a cut verb", () => {
    expect(classifyIntent("the meeting was from 2:00 to 3:00")).toBe("unknown");
  });
});

describe("parseTimestamp", () => {
  it("parses mm:ss into seconds", () => {
    expect(parseTimestamp("0:00")).toBe(0);
    expect(parseTimestamp("2:23")).toBe(143);
    expect(parseTimestamp("59:59")).toBe(3599);
  });

  it("parses h:mm:ss into seconds", () => {
    expect(parseTimestamp("1:02:03")).toBe(3723);
  });

  it("rejects out-of-range minutes/seconds", () => {
    expect(parseTimestamp("0:60")).toBeNull();
    expect(parseTimestamp("1:60:00")).toBeNull();
  });
});

describe("parseTimeRange", () => {
  it("pulls a (start, end) pair out of a prompt", () => {
    expect(parseTimeRange("cut 2:23 to 3:45")).toEqual({ startSecs: 143, endSecs: 225 });
    expect(parseTimeRange("drop between 0:30 and 0:40")).toEqual({
      startSecs: 30,
      endSecs: 40,
    });
  });

  it("rejects an end at or before the start", () => {
    expect(parseTimeRange("from 1:00 to 0:30")).toBeNull();
    expect(parseTimeRange("1:00 to 1:00")).toBeNull();
  });
});

describe("planFromUserPrompt", () => {
  it("returns an actionable proposal with delete ops when fillers exist", () => {
    const p = planFromUserPrompt("cut the fillers", FILLER_TRANSCRIPT);
    expect(p.intent).toBe("cut_fillers");
    expect(p.actionable).toBe(true);
    expect(p.ops.length).toBe(2);
    for (const op of p.ops) {
      expect(op.kind).toBe("clip_delete");
    }
    expect(p.body).toMatch(/2 filler word/);
  });

  it("reports a non-actionable proposal when there are no fillers", () => {
    const p = planFromUserPrompt("remove fillers", CLEAN_TRANSCRIPT);
    expect(p.intent).toBe("cut_fillers");
    expect(p.actionable).toBe(false);
    expect(p.ops).toEqual([]);
    expect(p.body).toMatch(/no filler words/i);
  });

  it("defers silence stripping to a later slice", () => {
    const p = planFromUserPrompt("cut the silences", FILLER_TRANSCRIPT);
    expect(p.intent).toBe("cut_silences");
    expect(p.actionable).toBe(false);
    expect(p.ops).toEqual([]);
    expect(p.body).toMatch(/silence/i);
  });

  it("explains that no transcript is loaded when the state is null", () => {
    const p = planFromUserPrompt("cut the fillers", null);
    expect(p.actionable).toBe(false);
    expect(p.body).toMatch(/no transcript/i);
  });

  it("declines unknown intents with a helpful message", () => {
    const p = planFromUserPrompt("make it more entertaining", FILLER_TRANSCRIPT);
    expect(p.intent).toBe("unknown");
    expect(p.actionable).toBe(false);
    expect(p.ops).toEqual([]);
    expect(p.body).toMatch(/don't know how/i);
  });

  it("builds delete ops for a time-range prompt", () => {
    // Build a transcript spanning 0–4 real seconds (in ticks) so the
    // mm:ss → tick conversion lines up. Each "word" is 1 second long.
    const tps = Number(TICKS_PER_SECOND);
    const RANGE_TRANSCRIPT: TranscriptState = {
      transcript: {
        source_id: "src-test",
        language: "en",
        segments: [],
        words: [
          { word: "one", start_ticks: 0, end_ticks: tps, probability: 0.9 },
          { word: "two", start_ticks: tps, end_ticks: 2 * tps, probability: 0.9 },
          { word: "three", start_ticks: 2 * tps, end_ticks: 3 * tps, probability: 0.9 },
          { word: "four", start_ticks: 3 * tps, end_ticks: 4 * tps, probability: 0.9 },
        ],
      },
      deleted: new Set<number>(),
      ingest: {
        wordToClipId: new Map<number, string>([
          [0, "c0"],
          [1, "c1"],
          [2, "c2"],
          [3, "c3"],
        ]),
        wordToTimelineAt: new Map<number, number>([
          [0, 0],
          [1, tps],
          [2, 2 * tps],
          [3, 3 * tps],
        ]),
      },
    };
    const p = planFromUserPrompt("drop 0:01 to 0:03", RANGE_TRANSCRIPT);
    expect(p.intent).toBe("cut_range");
    expect(p.actionable).toBe(true);
    // Words at [1s, 2s] and [2s, 3s] both sit fully inside [1, 3].
    expect(p.deletedWordIndices).toEqual([1, 2]);
    expect(p.ops.length).toBe(2);
  });

  it("reports nothing-to-cut when the range has no matching words", () => {
    const p = planFromUserPrompt("drop 10:00 to 11:00", FILLER_TRANSCRIPT);
    expect(p.intent).toBe("cut_range");
    expect(p.actionable).toBe(false);
    expect(p.ops).toEqual([]);
    expect(p.body).toMatch(/no transcript words/i);
  });
});
