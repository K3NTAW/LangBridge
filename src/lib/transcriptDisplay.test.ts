import { describe, expect, it } from "vitest";

import {
  formatParenTimestamp,
  layoutTranscriptWords,
  whisperChipLabel,
} from "./transcriptDisplay";
import { TICKS_PER_SECOND as TPS } from "./time";

describe("formatParenTimestamp", () => {
  it("formats zero", () => {
    expect(formatParenTimestamp(0)).toBe("(0:00)");
  });

  it("pads seconds under 10", () => {
    expect(formatParenTimestamp(65)).toBe("(1:05)");
  });

  it("floors fractional seconds", () => {
    expect(formatParenTimestamp(9.9)).toBe("(0:09)");
  });
});

describe("whisperChipLabel", () => {
  it("trims ends and collapses internal whitespace", () => {
    expect(whisperChipLabel("  hello\tworld  ")).toBe("hello world");
  });

  it("strips Whisper-style leading boundary spaces used between DTW tokens", () => {
    expect(whisperChipLabel(" what's")).toBe("what's");
  });
});

describe("layoutTranscriptWords", () => {
  const T = Number(TPS);

  it("stamps the first word and inserts rhythm stamps during monologue", () => {
    const words = [
      { start_ticks: 0, end_ticks: Math.floor(0.5 * T) },
      { start_ticks: Math.floor(1 * T), end_ticks: Math.floor(1.4 * T) },
      { start_ticks: Math.floor(7 * T), end_ticks: Math.floor(7.5 * T) }, // +6s → rhythm stamp
    ];
    const layout = layoutTranscriptWords(words, { rhythm_sec: 6, pause_sec: 99 });
    expect(layout.filter((x) => x.kind === "stamp").length).toBe(2);
    expect(layout[0]).toEqual({ kind: "stamp", seconds: 0 });
    expect(layout.findIndex((x) => x.kind === "stamp" && x.seconds === 7)).toBeGreaterThan(0);
  });

  it("stamps after a pause even below rhythm interval", () => {
    const words = [
      { start_ticks: 0, end_ticks: Math.floor(0.2 * T) },
      {
        start_ticks: Math.floor(3 * T),
        end_ticks: Math.floor(3.3 * T),
      }, // 3s gap
    ];
    const layout = layoutTranscriptWords(words, {
      pause_sec: 1.5,
      rhythm_sec: 99,
      paragraph_gap_sec: 99,
    });
    const stamps = layout.filter((x) => x.kind === "stamp");
    expect(stamps.length).toBe(2);
    expect(stamps[1]).toEqual({ kind: "stamp", seconds: 3 });
  });

  it("inserts a paragraph token after long silence", () => {
    const words = [
      { start_ticks: 0, end_ticks: Math.floor(0.2 * T) },
      {
        start_ticks: Math.floor(20 * T),
        end_ticks: Math.floor(20.5 * T),
      },
    ];
    const layout = layoutTranscriptWords(words, {
      pause_sec: 1,
      paragraph_gap_sec: 10,
    });
    expect(layout.some((x) => x.kind === "paragraph")).toBe(true);
  });
});
