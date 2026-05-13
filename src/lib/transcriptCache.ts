/**
 * Disk cache for Whisper transcripts (sift-ai output).
 *
 * Each video gets one JSON file at `<folder>/.sift/transcripts/<key>.json`
 * where `<key>` is a deterministic hash of (absolute path, mtime, size,
 * whisper-model-id). Mtime + size mean reprocessing the same file with
 * the same model returns the cached transcript instantly; modifying or
 * replacing the video invalidates the cache.
 *
 * This unblocks two things:
 *   • A folder-pane transcription queue can pre-warm every video without
 *     forcing the user to wait every time they re-open the app.
 *   • The transcript editor reads from cache when present, falls back
 *     to a live `aiClient.transcribe` call when not.
 */
import {
  exists,
  mkdir,
  readTextFile,
  stat,
  writeTextFile,
} from "@tauri-apps/plugin-fs";

import type { Transcript } from "./aiClient";

/** Disk envelope wrapping a cached transcript with provenance metadata. */
interface CachedTranscriptFile {
  /** Format version — bump on breaking shape changes. */
  v: 1;
  /** Absolute path that produced this transcript. */
  source_path: string;
  /** Whisper model id (e.g. "tiny.en", "base.en"). */
  whisper_model: string;
  /** Source file size in bytes when transcribed. */
  source_size_bytes: number;
  /** Source file mtime ms when transcribed. */
  source_mtime_ms: number;
  /** Epoch ms when the transcript was written. */
  cached_at_ms: number;
  /** The transcript payload itself. */
  transcript: Transcript;
}

/**
 * Lightweight non-crypto hash (FNV-1a, 32-bit) that produces a stable
 * filename-safe key from a string. We don't need cryptographic strength
 * — just deterministic file naming with collision resistance for the
 * handful of paths in one folder.
 */
function fnv1aHex(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // 32-bit FNV prime multiplication
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Compute the cache filename (no path) for a given source. */
export function transcriptCacheKey(
  sourcePath: string,
  whisperModel: string,
): string {
  // Slug the basename for human readability + a hash for collision/uniqueness.
  const baseSlash = sourcePath.lastIndexOf("/");
  const baseBack = sourcePath.lastIndexOf("\\");
  const cut = Math.max(baseSlash, baseBack);
  const basename = cut === -1 ? sourcePath : sourcePath.slice(cut + 1);
  const slug =
    basename.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60) || "video";
  const hash = fnv1aHex(`${sourcePath}|${whisperModel}`);
  return `${slug}.${hash}.json`;
}

/** Full path to the cached transcript for the supplied folder + source. */
export function transcriptCachePath(
  siftPath: string,
  sourcePath: string,
  whisperModel: string,
): string {
  return `${siftPath}/transcripts/${transcriptCacheKey(sourcePath, whisperModel)}`;
}

interface StatLike {
  size: number;
  mtimeMs: number;
}

async function safeStat(path: string): Promise<StatLike | null> {
  try {
    const s = await stat(path);
    const size = typeof s.size === "number" ? s.size : 0;
    const m = s.mtime instanceof Date ? s.mtime.getTime() : 0;
    return { size, mtimeMs: m };
  } catch {
    return null;
  }
}

/**
 * Look up a cached transcript on disk. Returns `null` when no cache
 * exists, when the cache file is unreadable / malformed, or when the
 * source file's size or mtime has changed since the cache was written.
 */
export async function readCachedTranscript(
  siftPath: string,
  sourcePath: string,
  whisperModel: string,
): Promise<Transcript | null> {
  const filePath = transcriptCachePath(siftPath, sourcePath, whisperModel);
  if (!(await exists(filePath).catch(() => false))) return null;

  let parsed: CachedTranscriptFile;
  try {
    const raw = await readTextFile(filePath);
    parsed = JSON.parse(raw) as CachedTranscriptFile;
  } catch {
    return null;
  }
  if (parsed.v !== 1) return null;

  const live = await safeStat(sourcePath);
  if (live === null) {
    // Source missing — treat the cache as stale rather than fail.
    return null;
  }
  if (live.size !== parsed.source_size_bytes) return null;
  // Allow a small mtime drift (some filesystems normalise to seconds).
  if (Math.abs(live.mtimeMs - parsed.source_mtime_ms) > 2000) return null;

  return parsed.transcript;
}

/**
 * Persist a transcript to the cache. Creates the transcripts directory
 * if it's missing. Throws on filesystem failure — caller decides
 * whether to surface the error (it's recoverable; nothing breaks if a
 * write fails, we just re-transcribe next time).
 */
export async function writeCachedTranscript(
  siftPath: string,
  sourcePath: string,
  whisperModel: string,
  transcript: Transcript,
): Promise<void> {
  const transcriptsDir = `${siftPath}/transcripts`;
  if (!(await exists(transcriptsDir).catch(() => false))) {
    await mkdir(transcriptsDir, { recursive: true });
  }
  const live = await safeStat(sourcePath);
  const envelope: CachedTranscriptFile = {
    v: 1,
    source_path: sourcePath,
    whisper_model: whisperModel,
    source_size_bytes: live?.size ?? 0,
    source_mtime_ms: live?.mtimeMs ?? 0,
    cached_at_ms: Date.now(),
    transcript,
  };
  const filePath = transcriptCachePath(siftPath, sourcePath, whisperModel);
  await writeTextFile(filePath, JSON.stringify(envelope));
}
