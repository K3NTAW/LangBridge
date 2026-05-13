import { describe, expect, it } from "vitest";

import { mergePreviewRanges, type PreviewRenderRange } from "./previewRender";

function range(source: string, a: number, b: number): PreviewRenderRange {
  return { source_path: source, src_in_secs: a, src_out_secs: b };
}

describe("mergePreviewRanges", () => {
  it("returns input unchanged when there is 0 or 1 range", () => {
    expect(mergePreviewRanges([])).toEqual([]);
    const one = [range("a", 0, 1)];
    expect(mergePreviewRanges(one)).toEqual(one);
  });

  it("merges adjacent ranges in the same source (zero gap)", () => {
    const r = [range("a", 0, 1), range("a", 1, 2)];
    expect(mergePreviewRanges(r)).toEqual([range("a", 0, 2)]);
  });

  it("merges ranges with a sub-100ms gap (Whisper word-clip case)", () => {
    const r = [range("a", 0, 0.5), range("a", 0.51, 1.2)];
    expect(mergePreviewRanges(r)).toEqual([range("a", 0, 1.2)]);
  });

  it("keeps ranges with a gap larger than the threshold", () => {
    const r = [range("a", 0, 1), range("a", 1.5, 2)];
    expect(mergePreviewRanges(r)).toEqual([range("a", 0, 1), range("a", 1.5, 2)]);
  });

  it("does not merge across different sources", () => {
    const r = [range("a", 0, 1), range("b", 1, 2)];
    expect(mergePreviewRanges(r)).toEqual(r);
  });

  it("preserves total cut duration when nothing merges", () => {
    const r = [range("a", 0, 1), range("a", 2, 3), range("a", 5, 6)];
    expect(mergePreviewRanges(r)).toEqual(r);
  });

  it("collapses a long chain of Whisper-style ranges", () => {
    const r: PreviewRenderRange[] = [];
    let t = 0;
    for (let i = 0; i < 500; i++) {
      r.push(range("a", t, t + 0.4));
      t += 0.41; // 10ms gap
    }
    const out = mergePreviewRanges(r);
    expect(out).toHaveLength(1);
    expect(out[0]!.src_in_secs).toBe(0);
    // last range ended at 499 * 0.41 + 0.4
    expect(out[0]!.src_out_secs).toBeCloseTo(499 * 0.41 + 0.4, 6);
  });

  it("respects a custom gap threshold", () => {
    const r = [range("a", 0, 1), range("a", 1.4, 2)];
    expect(mergePreviewRanges(r, 0.5)).toEqual([range("a", 0, 2)]);
    expect(mergePreviewRanges(r, 0.05)).toEqual(r);
  });

  it("sorts by source then by start before merging", () => {
    const r = [range("b", 0, 1), range("a", 1, 2), range("a", 0, 1)];
    expect(mergePreviewRanges(r)).toEqual([range("a", 0, 2), range("b", 0, 1)]);
  });
});
