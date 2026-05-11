import { describe, expect, it } from "vitest";

import {
  DEFAULT_FILLERS,
  DEFAULT_MIN_CONFIDENCE,
  detectFillers,
  normalizeWord,
  type DetectableWord,
} from "./transcriptCleanup";

describe("normalizeWord", () => {
  it("lowercases", () => {
    expect(normalizeWord("UH")).toBe("uh");
    expect(normalizeWord("Um")).toBe("um");
  });

  it("trims whitespace including Whisper's leading space", () => {
    expect(normalizeWord(" um")).toBe("um");
    expect(normalizeWord("uh ")).toBe("uh");
    expect(normalizeWord("  uh  ")).toBe("uh");
  });

  it("strips trailing punctuation (Whisper attaches it to the preceding word)", () => {
    expect(normalizeWord("uh,")).toBe("uh");
    expect(normalizeWord("um.")).toBe("um");
    expect(normalizeWord("uh!")).toBe("uh");
    expect(normalizeWord("um?")).toBe("um");
    expect(normalizeWord("uh...")).toBe("uh");
  });

  it("strips leading punctuation", () => {
    expect(normalizeWord('"uh')).toBe("uh");
    expect(normalizeWord("'um")).toBe("um");
  });

  it("preserves internal characters", () => {
    expect(normalizeWord("don't")).toBe("don't");
    expect(normalizeWord("twenty-five")).toBe("twenty-five");
  });

  it("returns empty string for whitespace-only or punctuation-only input", () => {
    expect(normalizeWord("")).toBe("");
    expect(normalizeWord("   ")).toBe("");
    expect(normalizeWord(",.!?")).toBe("");
  });

  it("handles non-ASCII (unicode-aware)", () => {
    expect(normalizeWord(" café,")).toBe("café");
    expect(normalizeWord("¿qué?")).toBe("qué");
  });
});

describe("DEFAULT_FILLERS", () => {
  it("contains the canonical English fillers", () => {
    for (const f of ["um", "uh", "umm", "uhh", "ah", "er", "hmm"]) {
      expect(DEFAULT_FILLERS.has(f)).toBe(true);
    }
  });

  it("excludes meaningful discourse markers", () => {
    // These are deliberately NOT in the default set — too aggressive.
    for (const w of ["like", "actually", "basically", "literally", "well", "so", "right", "okay"]) {
      expect(DEFAULT_FILLERS.has(w)).toBe(false);
    }
  });

  it("entries are all lowercase and stripped (matches normalizeWord output)", () => {
    for (const f of DEFAULT_FILLERS) {
      expect(f).toBe(normalizeWord(f));
    }
  });
});

describe("detectFillers", () => {
  it("flags um and uh", () => {
    const words: DetectableWord[] = [
      { word: " So" },
      { word: " um" },
      { word: " I" },
      { word: " uh" },
      { word: " think" },
    ];
    expect(detectFillers(words)).toEqual([1, 3]);
  });

  it("returns empty for clean speech", () => {
    const words: DetectableWord[] = [
      { word: " The" },
      { word: " quick" },
      { word: " brown" },
      { word: " fox" },
    ];
    expect(detectFillers(words)).toEqual([]);
  });

  it("preserves input order in the returned indices", () => {
    const words: DetectableWord[] = [
      { word: " uh" },
      { word: " hello" },
      { word: " um" },
      { word: " world" },
      { word: " ah" },
    ];
    expect(detectFillers(words)).toEqual([0, 2, 4]);
  });

  it("matches words with trailing punctuation", () => {
    const words: DetectableWord[] = [
      { word: " um," },
      { word: " right." },
      { word: " uh!" },
    ];
    expect(detectFillers(words)).toEqual([0, 2]);
  });

  it("skips low-confidence matches by default", () => {
    const words: DetectableWord[] = [
      { word: " um", probability: 0.9 },
      { word: " uh", probability: 0.2 }, // below DEFAULT_MIN_CONFIDENCE
      { word: " ah", probability: 0.8 },
    ];
    expect(detectFillers(words)).toEqual([0, 2]);
  });

  it("respects DEFAULT_MIN_CONFIDENCE constant", () => {
    expect(DEFAULT_MIN_CONFIDENCE).toBeGreaterThan(0);
    expect(DEFAULT_MIN_CONFIDENCE).toBeLessThan(1);
    const justBelow: DetectableWord[] = [
      { word: " um", probability: DEFAULT_MIN_CONFIDENCE - 0.001 },
    ];
    const justAbove: DetectableWord[] = [
      { word: " um", probability: DEFAULT_MIN_CONFIDENCE },
    ];
    expect(detectFillers(justBelow)).toEqual([]);
    expect(detectFillers(justAbove)).toEqual([0]);
  });

  it("does not gate words that lack a probability field", () => {
    const words: DetectableWord[] = [{ word: " um" }, { word: " uh" }];
    expect(detectFillers(words)).toEqual([0, 1]);
  });

  it("respects a custom filler set", () => {
    const words: DetectableWord[] = [
      { word: " like" },
      { word: " literally" },
      { word: " um" },
    ];
    const custom = new Set(["like", "literally"]);
    expect(detectFillers(words, { fillers: custom })).toEqual([0, 1]);
  });

  it("respects a custom minConfidence override", () => {
    const words: DetectableWord[] = [{ word: " um", probability: 0.4 }];
    expect(detectFillers(words, { minConfidence: 0.3 })).toEqual([0]);
    expect(detectFillers(words, { minConfidence: 0.9 })).toEqual([]);
  });

  it("ignores empty / punctuation-only words", () => {
    const words: DetectableWord[] = [
      { word: "" },
      { word: "   " },
      { word: ",.!" },
      { word: " um" },
    ];
    expect(detectFillers(words)).toEqual([3]);
  });

  it("handles a realistic mix from a 20-word transcript", () => {
    // Synthesized to mimic the shape Whisper returns: leading spaces,
    // mixed-case isn't a thing for fillers, occasional punctuation.
    const words: DetectableWord[] = [
      { word: " So", probability: 0.95 },
      { word: " um,", probability: 0.88 },
      { word: " I", probability: 0.99 },
      { word: " was", probability: 0.97 },
      { word: " thinking", probability: 0.96 },
      { word: " uh", probability: 0.91 },
      { word: " maybe", probability: 0.94 },
      { word: " we", probability: 0.99 },
      { word: " could", probability: 0.97 },
      { word: " ah,", probability: 0.85 },
      { word: " try", probability: 0.95 },
      { word: " a", probability: 0.99 },
      { word: " new", probability: 0.95 },
      { word: " approach.", probability: 0.93 },
      { word: " Like", probability: 0.92 }, // discourse marker; intentionally NOT a filler
      { word: " what", probability: 0.96 },
      { word: " if", probability: 0.97 },
      { word: " we", probability: 0.99 },
      { word: " just", probability: 0.95 },
      { word: " hmm,", probability: 0.81 },
    ];
    // Expect the three sounds (um, uh, ah) and the trailing hmm. Like is
    // intentionally kept.
    expect(detectFillers(words)).toEqual([1, 5, 9, 19]);
  });
});
