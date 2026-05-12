/**
 * Pure helpers used by the transcript-editor pane.
 *
 * Kept out of the React component so they're testable in isolation.
 * They're also genuinely re-usable: the AI service or a future
 * automation surface can plant the same ingest layout into the
 * engine without going through the UI.
 */

import { asId, type ClipId, type Op, type SourceId, type TrackId } from "./ops";

/**
 * One transcribed word, in tick units. Must match the JSON shape
 * sift-ai's `/v1/transcribe` returns; we don't import `TranscriptWord`
 * directly to keep this module free of HTTP types.
 */
export interface IngestableWord {
  start_ticks: number;
  end_ticks: number;
}

export interface BuildIngestOpsResult {
  ops: Op[];
  /** Map from word index to the clip id assigned during ingest. */
  wordToClipId: Map<number, string>;
  /** Source id assigned to the imported video. */
  sourceId: string;
  /** Track id of the single video track that holds the per-word clips. */
  trackId: string;
}

/**
 * Tiny ULID-shaped (Crockford Base32, 26 chars) generator.
 *
 * Real ULIDs include a millisecond timestamp prefix for k-sortability;
 * we keep that here so the engine, which validates ULID parse, accepts
 * each id we synthesize for the ingest batch.
 */
export function ulidLite(): string {
  const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const time = Date.now();
  const timeChars: string[] = [];
  let t = time;
  for (let i = 0; i < 10; i++) {
    timeChars.unshift(ALPHABET[t % 32] ?? "0");
    t = Math.floor(t / 32);
  }
  const rand = new Uint8Array(16);
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    crypto.getRandomValues(rand);
  } else {
    for (let i = 0; i < rand.length; i++) rand[i] = Math.floor(Math.random() * 256);
  }
  const randChars: string[] = [];
  for (let i = 0; i < 16; i++) randChars.push(ALPHABET[(rand[i] ?? 0) % 32] ?? "0");
  return timeChars.join("") + randChars.join("");
}

/**
 * Build the ingest op list for a transcript: `SourceImport`,
 * `TrackAdd`, then one `ClipInsert` per word. Returns the op list
 * plus the word→clip-id mapping the UI uses to reconcile later edits.
 *
 * **Timeline placement:** clips use packed timeline positions (each clip
 * follows the previous on the edit timeline). Whisper word timings often
 * overlap in *source* time; the engine forbids overlapping clips on one
 * track, so we must not place clips at `timeline_at = word.start_ticks`.
 * Trim (`src_in` / `src_out`) stays aligned to the media so render/export
 * and `reconcileDeleted` remain correct.
 *
 * Words shorter than one tick (`start >= end`) are dropped — the
 * engine rejects `src_in >= src_out`, and Whisper occasionally emits
 * zero-duration filler tokens that would fail the validation otherwise.
 */
export function buildIngestOps(
  mediaPath: string,
  words: readonly IngestableWord[],
): BuildIngestOpsResult {
  const sourceIdRaw = ulidLite();
  const trackIdRaw = ulidLite();
  const sourceId = asId<"SourceId">(sourceIdRaw) as SourceId;
  const trackId = asId<"TrackId">(trackIdRaw) as TrackId;
  const ops: Op[] = [
    {
      kind: "source_import",
      source_id: sourceId,
      path: mediaPath,
      hash: `transcript-${ulidLite()}`,
    },
    {
      kind: "track_add",
      track_id: trackId,
      track_kind: "video",
      index: 0,
    },
  ];
  const wordToClipId = new Map<number, string>();

  const validIndices: number[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w.end_ticks > w.start_ticks) validIndices.push(i);
  }
  validIndices.sort((a, b) => {
    const wa = words[a]!;
    const wb = words[b]!;
    if (wa.start_ticks !== wb.start_ticks) return wa.start_ticks - wb.start_ticks;
    if (wa.end_ticks !== wb.end_ticks) return wa.end_ticks - wb.end_ticks;
    return a - b;
  });

  let timelineAt = 0n;
  for (const i of validIndices) {
    const w = words[i]!;
    const clipId = ulidLite();
    wordToClipId.set(i, clipId);
    const srcIn = BigInt(w.start_ticks);
    const srcOut = BigInt(w.end_ticks);
    ops.push({
      kind: "clip_insert",
      clip_id: asId<"ClipId">(clipId) as ClipId,
      track_id: trackId,
      source_id: sourceId,
      src_in: srcIn,
      src_out: srcOut,
      timeline_at: timelineAt,
    });
    timelineAt += srcOut - srcIn;
  }
  return { ops, wordToClipId, sourceId: sourceIdRaw, trackId: trackIdRaw };
}

/**
 * Given the live render plan from the engine and the transcript,
 * mark any word whose source span isn't fully covered by some kept
 * range as deleted.
 *
 * `O(n·m)` for n words and m ranges. After the engine merges adjacent
 * ranges there are usually far fewer ranges than words, so this is
 * cheap. If a real corpus shows it matters we can switch to binary
 * search per word (ranges are sorted by `start_ticks`).
 */
export function reconcileDeleted(
  words: readonly IngestableWord[],
  ranges: readonly { start_ticks: number; end_ticks: number }[],
): Set<number> {
  const deleted = new Set<number>();
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w.end_ticks <= w.start_ticks) continue;
    const kept = ranges.some(
      (r) => w.start_ticks >= r.start_ticks && w.end_ticks <= r.end_ticks,
    );
    if (!kept) deleted.add(i);
  }
  return deleted;
}
