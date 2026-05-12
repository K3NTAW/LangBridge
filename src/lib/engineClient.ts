/**
 * JSON-RPC client to the spawned `sift-engine-host` subprocess.
 *
 * Implementation note: this module is a *thin* wrapper over Tauri's
 * `invoke()`. The Rust side (`sift-app/src-tauri/src/engine.rs`) holds
 * the actual UDS connection; from TypeScript's perspective the engine
 * is a set of `engine_*` Tauri commands.
 *
 * ## Module fallback
 *
 * When loaded outside Tauri (Vitest, browser preview without the
 * native shell), `@tauri-apps/api/core::invoke` throws synchronously.
 * We detect that and substitute a tiny client that returns clear
 * "engine unavailable" errors so unit tests of consumers don't have to
 * mock the whole module.
 *
 * See `docs/architecture.md` §2.1 for the wider data flow.
 */
import { invoke } from "@tauri-apps/api/core";

import type { Op } from "./ops";
import { encodeOp } from "./ops";

// ── Wire types ────────────────────────────────────────────────────────

/** Engine version banner. Returned by `info()`. */
export interface EngineInfo {
  engine_version: string;
  spec_version: string;
}

/** Result of `new()`. `head` is `null` for a fresh project (no ops yet). */
export interface NewResult {
  project_id: string;
  head: string | null;
}

/** Result of `head()`. */
export interface HeadResult {
  project_id: string;
  head: string | null;
  n_ops: number;
  can_undo: boolean;
  can_redo: boolean;
}

/** Result of `apply()`. */
export interface ApplyResult {
  /** Op-id assigned to the just-applied op; becomes the new head. */
  head: string;
  /** Total number of ops applied since the last load/new. */
  n_ops: number;
  /** Whether `undo()` would succeed against the new head. */
  can_undo: boolean;
  /** Whether `redo()` has anything queued (becomes false after any apply). */
  can_redo: boolean;
}

/** Result of `applyBatch()`. */
export interface ApplyBatchResult {
  /** How many ops were successfully applied (== ops.length on success). */
  applied: number;
  /** Op-ids assigned, in apply order. */
  heads: string[];
  /** Final head after the batch, or null if the project had no prior ops
   *  AND an empty batch was applied (rare). */
  head: string | null;
  n_ops: number;
  can_undo: boolean;
  can_redo: boolean;
}

/**
 * `useEngineProject().applyBatch` returns this instead of raw `null` on
 * failure so callers can read `error` immediately after `await` (React may
 * not have re-rendered yet, so `project.error` can still be stale).
 */
export type ApplyBatchOutcome =
  | { ok: true; result: ApplyBatchResult }
  | { ok: false; error: string };

/** Shared "history-changing" result returned by undo/redo. */
export interface HistoryChange {
  /** New head op-id, or null if the undo emptied the log. */
  head: string | null;
  n_ops: number;
  can_undo: boolean;
  can_redo: boolean;
}

/** Result of `undo()`. Includes the op that was undone so the UI can
 *  reconcile its local view (e.g. mark a word as un-deleted). */
export interface UndoResult extends HistoryChange {
  undone_op_id: string;
  undone_op: Op;
}

/** Result of `redo()`. */
export interface RedoResult extends HistoryChange {
  redone_op_id: string;
  redone_op: Op;
}

/** A `(start_ticks, end_ticks)` source range for the export plan. */
export interface RenderRange {
  source_id: string;
  start_ticks: number;
  end_ticks: number;
}

/** Result of `renderRanges()`. */
export interface RenderRangesResult {
  ranges: RenderRange[];
  /** Track the ranges came from, or null if no video track is present. */
  track_id: string | null;
}

/** One clip on the primary video track — timeline-space (UI layout). */
export interface TimelineClipLayoutWire {
  clip_id: string;
  timeline_at: number;
  duration_ticks: number;
}

/** Result of `timelineLayout()` — mirrors JSON-RPC `timeline_layout`. */
export interface TimelineLayoutResult {
  track_id: string | null;
  timeline_duration_ticks: number;
  clips: TimelineClipLayoutWire[];
}

/** Primary media path for preview — mirrors JSON-RPC `preview_primary_media`. */
export interface PreviewPrimaryMediaResult {
  source_id: string;
  path: string;
  /** Present on engine builds that expose proxy-aware decode paths. */
  preview_decode_path?: string;
  duration_ticks: number;
}

/** Result of `inverse()`. The engine returns the inverse op, not applied. */
export interface InverseResult {
  inverse: Op;
}

/** Result of `save()`. */
export interface SaveResult {
  path: string;
  bytes_written: number;
}

/** Result of `load()`. */
export interface LoadResult {
  project_id: string;
  path: string;
}

// ── Errors ────────────────────────────────────────────────────────────

/**
 * Error thrown by every method on [`EngineClient`] when the engine
 * declines the request (op rejected, file not found, …) or the bridge
 * can't reach the engine at all.
 *
 * Tauri serializes Rust errors as plain strings, so `code` is parsed
 * out of the message when present (the Rust side formats them as
 * `"engine error <code>: <message>"`).
 */
export class EngineError extends Error {
  /** JSON-RPC error code if the engine returned one, else `undefined`. */
  readonly code: number | undefined;

  constructor(message: string, code?: number) {
    super(message);
    this.name = "EngineError";
    this.code = code;
  }

  static fromInvokeError(raw: unknown): EngineError {
    const msg = typeof raw === "string" ? raw : String(raw);
    const m = /^engine error (-?\d+):\s*(.*)$/.exec(msg);
    if (m && m[1] !== undefined) {
      const code = Number.parseInt(m[1], 10);
      return new EngineError(m[2] ?? msg, code);
    }
    return new EngineError(msg);
  }
}

/** Error code emitted when no project is loaded. Mirrors `host.rs`. */
export const CODE_NO_PROJECT = -32002;

// ── Client interface ──────────────────────────────────────────────────

export interface EngineClient {
  /** Engine version + spec version banner. */
  info(): Promise<EngineInfo>;
  /** Replace the engine's project with a fresh empty one. */
  newProject(): Promise<NewResult>;
  /** Current project id and head op-id (in-memory log). */
  head(): Promise<HeadResult>;
  /** Apply an op. The engine validates and mutates atomically. */
  apply(op: Op): Promise<ApplyResult>;
  /**
   * Apply a sequence of ops as one round-trip. The engine treats them
   * as N individual log entries; on first failure all preceding ops
   * in the batch are rolled back and an `EngineError` is thrown.
   */
  applyBatch(ops: Op[], options?: { group_undo?: boolean }): Promise<ApplyBatchResult>;
  /**
   * Compute (but don't apply) the inverse op. Useful for building
   * undo entries before `apply()`.
   */
  inverse(op: Op): Promise<InverseResult>;
  /** Undo the last applied op via its recorded inverse. */
  undo(): Promise<UndoResult>;
  /** Re-apply the most recently undone op. */
  redo(): Promise<RedoResult>;
  /** Source ranges for the active sequence's primary video track. */
  renderRanges(): Promise<RenderRangesResult>;
  /** Clip rectangles + timeline extent on the primary video track (for UI). */
  timelineLayout(): Promise<TimelineLayoutResult>;
  /**
   * Resolved filesystem path for native preview (single-source rule;
   * empty timeline + exactly one pool source also succeeds).
   */
  previewPrimaryMedia(): Promise<PreviewPrimaryMediaResult>;
  /**
   * Wipe the in-memory undo/redo log without touching project state.
   * Used after ingest so the user's first undo starts at the first
   * post-ingest edit.
   */
  clearHistory(): Promise<HistoryChange>;
  /** Persist the current project to `path`. */
  save(path: string): Promise<SaveResult>;
  /** Replace the engine's project with one loaded from `path`. */
  load(path: string): Promise<LoadResult>;
}

// ── Tauri-backed implementation ───────────────────────────────────────

class TauriEngineClient implements EngineClient {
  async info(): Promise<EngineInfo> {
    return await this.call("engine_info");
  }
  async newProject(): Promise<NewResult> {
    return await this.call("engine_new");
  }
  async head(): Promise<HeadResult> {
    return await this.call("engine_head");
  }
  async apply(op: Op): Promise<ApplyResult> {
    return await this.call("engine_apply", { op: encodeOp(op) });
  }
  async applyBatch(
    ops: Op[],
    options?: { group_undo?: boolean },
  ): Promise<ApplyBatchResult> {
    const payload: Record<string, unknown> = { ops: ops.map(encodeOp) };
    if (options?.group_undo === true) {
      payload.groupUndo = true;
    }
    return await this.call("engine_apply_batch", payload);
  }
  async inverse(op: Op): Promise<InverseResult> {
    return await this.call("engine_inverse", { op: encodeOp(op) });
  }
  async undo(): Promise<UndoResult> {
    return await this.call("engine_undo");
  }
  async redo(): Promise<RedoResult> {
    return await this.call("engine_redo");
  }
  async renderRanges(): Promise<RenderRangesResult> {
    return await this.call("engine_render_ranges");
  }
  async timelineLayout(): Promise<TimelineLayoutResult> {
    return await this.call("engine_timeline_layout");
  }
  async previewPrimaryMedia(): Promise<PreviewPrimaryMediaResult> {
    return await this.call("engine_preview_primary_media");
  }
  async clearHistory(): Promise<HistoryChange> {
    return await this.call("engine_clear_history");
  }
  async save(path: string): Promise<SaveResult> {
    return await this.call("engine_save", { path });
  }
  async load(path: string): Promise<LoadResult> {
    return await this.call("engine_load", { path });
  }

  private async call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    try {
      return (await invoke(cmd, args ?? {})) as T;
    } catch (e) {
      throw EngineError.fromInvokeError(e);
    }
  }
}

class UnavailableEngineClient implements EngineClient {
  private fail(method: string): never {
    throw new EngineError(`engine unavailable (${method} called outside Tauri)`);
  }
  async info(): Promise<EngineInfo> {
    return this.fail("info");
  }
  async newProject(): Promise<NewResult> {
    return this.fail("new");
  }
  async head(): Promise<HeadResult> {
    return this.fail("head");
  }
  async apply(_op: Op): Promise<ApplyResult> {
    return this.fail("apply");
  }
  async applyBatch(_ops: Op[], _options?: { group_undo?: boolean }): Promise<ApplyBatchResult> {
    return this.fail("applyBatch");
  }
  async inverse(_op: Op): Promise<InverseResult> {
    return this.fail("inverse");
  }
  async undo(): Promise<UndoResult> {
    return this.fail("undo");
  }
  async redo(): Promise<RedoResult> {
    return this.fail("redo");
  }
  async renderRanges(): Promise<RenderRangesResult> {
    return this.fail("renderRanges");
  }
  async timelineLayout(): Promise<TimelineLayoutResult> {
    return this.fail("timelineLayout");
  }
  async previewPrimaryMedia(): Promise<PreviewPrimaryMediaResult> {
    return this.fail("previewPrimaryMedia");
  }
  async clearHistory(): Promise<HistoryChange> {
    return this.fail("clearHistory");
  }
  async save(_path: string): Promise<SaveResult> {
    return this.fail("save");
  }
  async load(_path: string): Promise<LoadResult> {
    return this.fail("load");
  }
}

let _client: EngineClient | null = null;

/** Returns true when the page is loaded inside Tauri's webview. */
function isInTauri(): boolean {
  // Tauri 2 sets `__TAURI_INTERNALS__` on `window`.
  if (typeof window === "undefined") return false;
  return Object.prototype.hasOwnProperty.call(window, "__TAURI_INTERNALS__");
}

/**
 * Returns the singleton engine client. Inside Tauri this is a real
 * `invoke`-backed client; outside (e.g. Vitest), it returns a stub
 * that throws clear errors.
 */
export function getEngineClient(): EngineClient {
  if (_client === null) {
    _client = isInTauri() ? new TauriEngineClient() : new UnavailableEngineClient();
  }
  return _client;
}

/** **Test-only**: install a custom client (used by Vitest specs). */
export function __setEngineClientForTests(client: EngineClient | null): void {
  _client = client;
}
