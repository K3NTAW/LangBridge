import { describe, expect, it } from "vitest";

import {
  buildIngestOps,
  reconcileDeleted,
  ulidLite,
  type IngestableWord,
} from "./transcriptIngest";

describe("ulidLite", () => {
  it("returns a 26-character base32 string", () => {
    const id = ulidLite();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("is unique across many invocations", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(ulidLite());
    expect(ids.size).toBe(1000);
  });
});

describe("buildIngestOps", () => {
  it("emits source_import + track_add + one clip_insert per word", () => {
    const words: IngestableWord[] = [
      { start_ticks: 0, end_ticks: 1000 },
      { start_ticks: 2000, end_ticks: 3000 },
    ];
    const { ops, wordToClipId } = buildIngestOps("/tmp/x.mp4", words);
    expect(ops).toHaveLength(4);
    expect(ops[0]?.kind).toBe("source_import");
    expect(ops[1]?.kind).toBe("track_add");
    expect(ops[2]?.kind).toBe("clip_insert");
    expect(ops[3]?.kind).toBe("clip_insert");
    expect(wordToClipId.size).toBe(2);
  });

  it("threads a single source/track across all clip inserts", () => {
    const words: IngestableWord[] = [
      { start_ticks: 0, end_ticks: 100 },
      { start_ticks: 200, end_ticks: 300 },
      { start_ticks: 400, end_ticks: 500 },
    ];
    const { ops, sourceId, trackId } = buildIngestOps("/tmp/x.mp4", words);
    const clipInserts = ops.filter((o) => o.kind === "clip_insert");
    expect(clipInserts).toHaveLength(3);
    for (const op of clipInserts) {
      if (op.kind !== "clip_insert") throw new Error("unreachable");
      expect(op.source_id).toBe(sourceId);
      expect(op.track_id).toBe(trackId);
    }
  });

  it("uses BigInt ticks so engine wire serialization works", () => {
    const words: IngestableWord[] = [{ start_ticks: 12345, end_ticks: 67890 }];
    const { ops } = buildIngestOps("/tmp/x.mp4", words);
    const clipOp = ops[2];
    if (clipOp?.kind !== "clip_insert") throw new Error("expected clip_insert");
    expect(typeof clipOp.src_in).toBe("bigint");
    expect(clipOp.src_in).toBe(12345n);
    expect(clipOp.src_out).toBe(67890n);
    expect(clipOp.timeline_at).toBe(0n);
  });

  it("packs the edit timeline so overlapping Whisper-style timings stay valid", () => {
    const words: IngestableWord[] = [
      { start_ticks: 0, end_ticks: 1000 },
      { start_ticks: 500, end_ticks: 1500 },
    ];
    const { ops } = buildIngestOps("/tmp/x.mp4", words);
    const a = ops[2];
    const b = ops[3];
    if (a?.kind !== "clip_insert" || b?.kind !== "clip_insert") {
      throw new Error("expected clip_insert ops");
    }
    expect(a.timeline_at).toBe(0n);
    expect(b.timeline_at).toBe(1000n);
    expect(a.src_in).toBe(0n);
    expect(b.src_in).toBe(500n);
  });

  it("sorts by source start when inserting clips so packing matches chronological order", () => {
    const words: IngestableWord[] = [
      { start_ticks: 500, end_ticks: 800 },
      { start_ticks: 0, end_ticks: 400 },
    ];
    const { ops, wordToClipId } = buildIngestOps("/tmp/x.mp4", words);
    const first = ops[2];
    const second = ops[3];
    if (first?.kind !== "clip_insert" || second?.kind !== "clip_insert") {
      throw new Error("expected clip_insert ops");
    }
    expect(first.src_in).toBe(0n);
    expect(second.src_in).toBe(500n);
    expect(first.timeline_at).toBe(0n);
    expect(second.timeline_at).toBe(400n);
    expect(wordToClipId.get(0)).toBe(second.clip_id);
    expect(wordToClipId.get(1)).toBe(first.clip_id);
  });

  it("drops zero-duration words rather than emitting an op the engine would reject", () => {
    const words: IngestableWord[] = [
      { start_ticks: 0, end_ticks: 100 },
      { start_ticks: 200, end_ticks: 200 },   // zero-duration
      { start_ticks: 300, end_ticks: 250 },   // inverted
      { start_ticks: 400, end_ticks: 500 },
    ];
    const { ops, wordToClipId } = buildIngestOps("/tmp/x.mp4", words);
    expect(ops.filter((o) => o.kind === "clip_insert")).toHaveLength(2);
    expect(wordToClipId.has(0)).toBe(true);
    expect(wordToClipId.has(1)).toBe(false);
    expect(wordToClipId.has(2)).toBe(false);
    expect(wordToClipId.has(3)).toBe(true);
  });
});

describe("reconcileDeleted", () => {
  const words: IngestableWord[] = [
    { start_ticks: 0, end_ticks: 100 },
    { start_ticks: 200, end_ticks: 300 },
    { start_ticks: 400, end_ticks: 500 },
    { start_ticks: 600, end_ticks: 700 },
  ];

  it("returns empty set when all words are covered by some range", () => {
    const ranges = [{ start_ticks: 0, end_ticks: 700 }];
    expect(reconcileDeleted(words, ranges).size).toBe(0);
  });

  it("returns all word indices when there are no kept ranges", () => {
    const deleted = reconcileDeleted(words, []);
    expect(deleted.size).toBe(4);
    expect([...deleted].sort()).toEqual([0, 1, 2, 3]);
  });

  it("flags only the words whose source span isn't covered", () => {
    const ranges = [
      { start_ticks: 0, end_ticks: 100 },
      { start_ticks: 400, end_ticks: 700 },
    ];
    const deleted = reconcileDeleted(words, ranges);
    expect([...deleted].sort()).toEqual([1]);
  });

  it("treats a word fully inside a single range as kept even with sibling ranges absent", () => {
    const ranges = [{ start_ticks: 250, end_ticks: 550 }];
    const deleted = reconcileDeleted(words, ranges);
    expect([...deleted].sort()).toEqual([0, 1, 3]);
  });

  it("treats a partially-overlapping range as not kept (engine merges before we see it, so this shouldn't happen, but be safe)", () => {
    // word 0 = [0, 100); range [50, 150) only partially covers it.
    const ranges = [{ start_ticks: 50, end_ticks: 150 }];
    const deleted = reconcileDeleted(words, ranges);
    expect(deleted.has(0)).toBe(true);
  });

  it("ignores zero-duration words (matches buildIngestOps' drop policy)", () => {
    const wordsWithZero: IngestableWord[] = [
      ...words,
      { start_ticks: 800, end_ticks: 800 },
    ];
    const ranges = [{ start_ticks: 0, end_ticks: 1000 }];
    expect(reconcileDeleted(wordsWithZero, ranges).has(4)).toBe(false);
  });
});
