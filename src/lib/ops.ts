/**
 * Op language — TypeScript mirror of `sift-engine/src/ops.rs`.
 *
 * **Source of truth is the Rust file.** When the engine adds a new op, mirror
 * it here. The two files MUST agree. A round-trip property test in CI verifies
 * that ops constructed in TS deserialize cleanly in Rust and vice versa.
 *
 * See `docs/spec.md` §2 for the canonical op set.
 */

import type { Tick, Rate } from "./time";

// ── ID newtypes (string brand) ────────────────────────────────────────
// We don't enforce the brand at runtime — it's a TS-only check that
// catches "passed a TrackId where a ClipId was expected" at the type level.

declare const __brand: unique symbol;
type Brand<T, B> = T & { readonly [__brand]: B };

export type ProjectId = Brand<string, "ProjectId">;
export type SourceId = Brand<string, "SourceId">;
export type SequenceId = Brand<string, "SequenceId">;
export type TrackId = Brand<string, "TrackId">;
export type ClipId = Brand<string, "ClipId">;
export type EffectId = Brand<string, "EffectId">;
export type MarkerId = Brand<string, "MarkerId">;
export type ClientId = Brand<string, "ClientId">;

/** Cast a raw string into a typed ID. Use only at the JSON boundary. */
export function asId<B extends string>(s: string): Brand<string, B> {
  return s as Brand<string, B>;
}

// ── Enums (string unions, snake_case to match Rust serde) ─────────────

export type Edge = "in" | "out";
export type TrackKind = "video" | "audio" | "subtitle";
export type EffectKind =
  | "color"
  | "lut"
  | "blur"
  | "transform"
  | "crop"
  | "audio_eq"
  | "audio_compressor"
  | "audio_denoise";
export type MarkerKind = "generic" | "ai_suggestion" | "chapter" | "comment";

export interface ColorRgba8 {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface ContentHash {
  // serde uses #[serde(transparent)] so it's just the hex string at the wire.
  // We keep the type as a single-field shape so the Rust→TS migration is
  // mechanical, but this serializes to a bare string.
  toString(): string;
}

export interface EffectParams {
  [key: string]: unknown;
}

export type SelectableId =
  | { kind: "clip"; id: ClipId }
  | { kind: "track"; id: TrackId }
  | { kind: "marker"; id: MarkerId };

// ── The Op union ──────────────────────────────────────────────────────

export type Op =
  // Media pool
  | {
      kind: "source_import";
      source_id: SourceId;
      path: string;
      hash: string;
      /** When omitted, engine treats as no proxy (serde default). */
      proxy_path?: string | null;
    }
  | { kind: "source_remove"; source_id: SourceId }
  | {
      kind: "source_set_proxy";
      source_id: SourceId;
      /** `null` or omit clears the proxy path on the source. */
      proxy_path?: string | null;
    }
  // Tracks
  | { kind: "track_add"; track_id: TrackId; track_kind: TrackKind; index: number }
  | { kind: "track_remove"; track_id: TrackId }
  | { kind: "track_rename"; track_id: TrackId; name: string }
  | { kind: "track_set_mute"; track_id: TrackId; muted: boolean }
  | { kind: "track_set_solo"; track_id: TrackId; solo: boolean }
  | { kind: "track_set_lock"; track_id: TrackId; locked: boolean }
  // Clips
  | {
      kind: "clip_insert";
      clip_id: ClipId;
      track_id: TrackId;
      source_id: SourceId;
      src_in: Tick;
      src_out: Tick;
      timeline_at: Tick;
    }
  | { kind: "clip_move"; clip_id: ClipId; delta: Tick; target_track: TrackId | null }
  | { kind: "clip_trim"; clip_id: ClipId; edge: Edge; delta: Tick }
  | { kind: "clip_split"; clip_id: ClipId; at: Tick; new_clip_id: ClipId }
  | { kind: "clip_delete"; clip_id: ClipId; ripple: boolean }
  | {
      kind: "clip_replace_source";
      clip_id: ClipId;
      source_id: SourceId;
      src_in: Tick;
      src_out: Tick;
    }
  // Effects
  | {
      kind: "effect_add";
      clip_id: ClipId;
      effect_id: EffectId;
      effect_kind: EffectKind;
      params: EffectParams;
      /** When omitted, the engine treats this as `true` (effect runs). */
      enabled?: boolean;
    }
  | { kind: "effect_remove"; clip_id: ClipId; effect_id: EffectId }
  | { kind: "effect_set_params"; clip_id: ClipId; effect_id: EffectId; params: EffectParams }
  | { kind: "effect_set_enabled"; clip_id: ClipId; effect_id: EffectId; enabled: boolean }
  // Markers
  | {
      kind: "marker_add";
      marker_id: MarkerId;
      at: Tick;
      label: string;
      color: ColorRgba8;
      marker_kind: MarkerKind;
    }
  | { kind: "marker_remove"; marker_id: MarkerId }
  | { kind: "marker_update"; marker_id: MarkerId; label: string | null; at: Tick | null }
  // Sequence meta
  | {
      kind: "sequence_create";
      sequence_id: SequenceId;
      name: string;
      frame_rate: Rate;
      sample_rate: number;
    }
  | { kind: "sequence_rename"; sequence_id: SequenceId; name: string }
  | { kind: "sequence_set_frame_rate"; sequence_id: SequenceId; rate: Rate }
  // Audio
  | { kind: "clip_set_gain"; clip_id: ClipId; gain_db_q: number }
  | { kind: "clip_set_pan"; clip_id: ClipId; pan_q: number }
  // Selection (transient — recorded but not undoable)
  | { kind: "selection_set"; client_id: ClientId; items: SelectableId[] };

/** Discriminate the union by `kind`. */
export type OpKind = Op["kind"];

/** Whether this op contributes to the undo history. */
export function isUndoable(op: Op): boolean {
  return op.kind !== "selection_set";
}

/**
 * JSON encoding helper. JSON.stringify can't serialize `bigint` natively,
 * but the engine expects ticks as JSON numbers. Coerce here, asserting
 * that we're within the safe-integer range (i.e. the project is shorter
 * than ~36 000 years).
 */
export function encodeOp(op: Op): unknown {
  return JSON.parse(
    JSON.stringify(op, (_key, value) => {
      if (typeof value === "bigint") {
        if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
          throw new RangeError(
            `tick value ${value} exceeds JS safe integer range; this should not happen for any sane project`,
          );
        }
        return Number(value);
      }
      return value;
    }),
  );
}
