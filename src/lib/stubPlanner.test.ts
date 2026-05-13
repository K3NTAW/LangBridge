import { describe, expect, it } from "vitest";

import { classifyIntent, planFromUserPrompt } from "./stubPlanner";
import type { TranscriptState } from "./transcriptOps";

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
});
