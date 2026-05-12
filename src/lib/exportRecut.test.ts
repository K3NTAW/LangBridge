import { describe, expect, it } from "vitest";

import { renderRangesToRecutRanges } from "./exportRecut";

describe("renderRangesToRecutRanges", () => {
  it("copies tick boundaries for sift-ai recut", () => {
    const ranges = [
      { source_id: "src_a", start_ticks: 0, end_ticks: 100 },
      { source_id: "src_a", start_ticks: 200, end_ticks: 500 },
    ];
    expect(renderRangesToRecutRanges(ranges)).toEqual([
      { start_ticks: 0, end_ticks: 100 },
      { start_ticks: 200, end_ticks: 500 },
    ]);
  });

  it("returns empty array when engine plan has no kept spans", () => {
    expect(renderRangesToRecutRanges([])).toEqual([]);
  });
});
