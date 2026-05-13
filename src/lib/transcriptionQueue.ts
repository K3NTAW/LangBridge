/**
 * Folder-level transcription queue (Milestone A #6).
 *
 * Drives all videos in an open folder through Whisper in the background,
 * with a small concurrency limit. Each video's state is exposed to the
 * folder pane so it can render per-row status badges.
 *
 * Cache-aware: before calling sift-ai, the queue checks
 * `lib/transcriptCache` for a prior transcript of the same source +
 * model. Cache hits skip Whisper entirely and land in `ready` instantly.
 *
 * This module does NOT ingest the transcript into the engine — that's
 * still the transcript pane's job when the user activates the video.
 * The queue's responsibility ends at "transcript text + word timings
 * exist on disk".
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { AIServiceError, getAIClient } from "./aiClient";
import { readCachedTranscript, writeCachedTranscript } from "./transcriptCache";
import type { Transcript } from "./aiClient";

export type TranscriptionStatus =
  | "queued"
  | "transcribing"
  | "ready"
  | "failed"
  | "skipped";

export interface TranscriptionEntry {
  status: TranscriptionStatus;
  /** Populated when status === "failed". */
  error?: string;
  /** Source of the result, when applicable. */
  source?: "cache" | "whisper";
}

interface UseTranscriptionQueueArgs {
  /** Hidden `.sift/` directory for the active folder, or null when none. */
  siftPath: string | null;
  /** Whisper model id; "" disables transcription entirely. */
  whisperModel: string;
  /** Max parallel sift-ai requests in flight. Default 2. */
  concurrency?: number;
}

/** Default concurrency: enough to overlap I/O with compute on a typical Mac without saturating sift-ai. */
const DEFAULT_CONCURRENCY = 2;

/**
 * Hook returning the queue surface used by App.tsx + FolderPane.
 *
 *   • `statusOf(path)` — current TranscriptionEntry for a path.
 *   • `enqueueAll(paths)` — mark each as `queued` and drain the
 *     worker until all reach a terminal state.
 *   • `reset()` — wipe the queue (e.g. when switching folders).
 */
export function useTranscriptionQueue({
  siftPath,
  whisperModel,
  concurrency = DEFAULT_CONCURRENCY,
}: UseTranscriptionQueueArgs) {
  const [entries, setEntries] = useState<ReadonlyMap<string, TranscriptionEntry>>(
    () => new Map(),
  );

  // Mutable mirrors so the worker can read fresh values without
  // depending on state. State is the source of truth for renders;
  // refs are the source of truth for the worker.
  const entriesRef = useRef<Map<string, TranscriptionEntry>>(new Map());
  const queueRef = useRef<string[]>([]);
  const inFlightRef = useRef<Set<string>>(new Set());
  const siftPathRef = useRef<string | null>(siftPath);
  const modelRef = useRef<string>(whisperModel);

  useEffect(() => {
    siftPathRef.current = siftPath;
  }, [siftPath]);
  useEffect(() => {
    modelRef.current = whisperModel;
  }, [whisperModel]);

  /** Commit a new entries map to state (and the ref). */
  const commit = useCallback((next: Map<string, TranscriptionEntry>) => {
    entriesRef.current = next;
    setEntries(new Map(next));
  }, []);

  /** Patch one entry, preserving others. */
  const patch = useCallback(
    (path: string, entry: TranscriptionEntry) => {
      const next = new Map(entriesRef.current);
      next.set(path, entry);
      commit(next);
    },
    [commit],
  );

  /** Pull the next queued item that isn't already in flight. */
  const dequeue = useCallback((): string | null => {
    while (queueRef.current.length > 0) {
      const candidate = queueRef.current.shift()!;
      if (inFlightRef.current.has(candidate)) continue;
      const e = entriesRef.current.get(candidate);
      // Skip if it left the queue (e.g. a duplicate enqueue + cache hit).
      if (e && e.status !== "queued") continue;
      return candidate;
    }
    return null;
  }, []);

  /** Run one video end-to-end (cache → Whisper → cache write). */
  const runOne = useCallback(async (path: string) => {
    inFlightRef.current.add(path);
    patch(path, { status: "transcribing" });

    const sift = siftPathRef.current;
    const model = modelRef.current;

    // No Whisper model selected → mark skipped so the row shows clearly
    // (and we don't burn through the queue silently).
    if (!model.trim()) {
      patch(path, { status: "skipped", error: "No Whisper model selected." });
      inFlightRef.current.delete(path);
      return;
    }

    // 1) Cache lookup
    if (sift) {
      try {
        const cached = await readCachedTranscript(sift, path, model);
        if (cached !== null) {
          patch(path, { status: "ready", source: "cache" });
          inFlightRef.current.delete(path);
          return;
        }
      } catch {
        // Cache failures are non-fatal; fall through.
      }
    }

    // 2) Live transcription via sift-ai
    let transcript: Transcript;
    try {
      transcript = await getAIClient().transcribe(path, "local", {
        whisper_model: model,
      });
    } catch (e) {
      const msg =
        e instanceof AIServiceError
          ? e.detail
          : e instanceof Error
            ? e.message
            : String(e);
      patch(path, { status: "failed", error: msg });
      inFlightRef.current.delete(path);
      return;
    }

    // 3) Write-through
    if (sift) {
      void writeCachedTranscript(sift, path, model, transcript).catch(() => {});
    }
    patch(path, { status: "ready", source: "whisper" });
    inFlightRef.current.delete(path);
  }, [patch]);

  /** Refill the in-flight pool until either empty or saturated. */
  const drain = useCallback(() => {
    while (inFlightRef.current.size < concurrency) {
      const next = dequeue();
      if (next === null) return;
      void runOne(next).finally(() => {
        // Each completion gives us a chance to start another.
        drain();
      });
    }
  }, [concurrency, dequeue, runOne]);

  /** Enqueue a list of paths. Paths already in a terminal state are skipped. */
  const enqueueAll = useCallback(
    (paths: readonly string[]) => {
      const next = new Map(entriesRef.current);
      let added = 0;
      for (const p of paths) {
        const existing = next.get(p);
        if (existing && (existing.status === "ready" || existing.status === "transcribing")) {
          continue;
        }
        next.set(p, { status: "queued" });
        queueRef.current.push(p);
        added += 1;
      }
      if (added > 0) {
        commit(next);
        drain();
      }
    },
    [commit, drain],
  );

  /** Drop everything. Used when switching folders. */
  const reset = useCallback(() => {
    queueRef.current.length = 0;
    inFlightRef.current.clear();
    commit(new Map());
  }, [commit]);

  /** Re-check the cache for one path (e.g. after the user manually transcribed via the pane). */
  const markReadyFromCache = useCallback(
    (path: string) => {
      patch(path, { status: "ready", source: "cache" });
    },
    [patch],
  );

  const statusOf = useCallback(
    (path: string): TranscriptionEntry =>
      entriesRef.current.get(path) ?? { status: "queued" },
    [],
  );

  return {
    /** Read-only map for components to render from. */
    entries,
    statusOf,
    enqueueAll,
    reset,
    markReadyFromCache,
  };
}
