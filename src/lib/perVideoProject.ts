/**
 * Per-video engine project files.
 *
 * The folder-as-project model originally stored a single `project.json`
 * at the folder root. That worked for a one-video session, but switching
 * to another video wiped the engine state (and the edits the user had
 * made), because `TranscriptEditorPane.runTranscribePipeline` calls
 * `project.newProject()` on each bootstrap.
 *
 * Fix: give every video in the folder its own engine project file
 * under `<siftPath>/projects/`. Switching videos = save the current
 * file, then load (or freshly create) the next one. Each video also
 * persists the `wordIndex → clipId` mapping side-by-side so we can
 * skip re-ingest when the engine state is already on disk.
 */
import {
  exists,
  mkdir,
  readTextFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";

/** FNV-1a 32-bit — same hash the transcript cache uses. */
function fnv1aHex(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i === -1 ? p : p.slice(i + 1);
}

/** Filename slug for a video path — human-greppable + hash-suffixed. */
function videoSlug(videoPath: string): string {
  const slug = basename(videoPath)
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 60) || "video";
  return `${slug}.${fnv1aHex(videoPath)}`;
}

/** Engine project file path for one video. */
export function getVideoProjectPath(siftPath: string, videoPath: string): string {
  return `${siftPath}/projects/${videoSlug(videoPath)}.json`;
}

/** Sidecar file holding the wordIndex → clipId mapping for one video. */
export function getVideoIngestPath(siftPath: string, videoPath: string): string {
  return `${siftPath}/projects/${videoSlug(videoPath)}.ingest.json`;
}

interface CachedIngestFile {
  v: 1;
  source_path: string;
  /** Pairs of `[wordIndex, clipId]`, deterministic ordering. */
  word_to_clip_id: Array<[number, string]>;
  cached_at_ms: number;
}

/**
 * Read a previously persisted `wordToClipId` map. Returns null if the
 * sidecar is missing, malformed, or doesn't match the source path.
 */
export async function readCachedIngest(
  siftPath: string,
  videoPath: string,
): Promise<Map<number, string> | null> {
  const path = getVideoIngestPath(siftPath, videoPath);
  if (!(await exists(path).catch(() => false))) return null;
  try {
    const raw = await readTextFile(path);
    const parsed = JSON.parse(raw) as CachedIngestFile;
    if (parsed.v !== 1) return null;
    if (parsed.source_path !== videoPath) return null;
    return new Map(parsed.word_to_clip_id);
  } catch {
    return null;
  }
}

/**
 * Persist the wordIndex → clipId mapping for a video. Failures are
 * non-fatal — callers should swallow rejections; the next ingest will
 * just rebuild the mapping from scratch.
 */
export async function writeCachedIngest(
  siftPath: string,
  videoPath: string,
  wordToClipId: ReadonlyMap<number, string>,
): Promise<void> {
  const projectsDir = `${siftPath}/projects`;
  if (!(await exists(projectsDir).catch(() => false))) {
    await mkdir(projectsDir, { recursive: true });
  }
  const envelope: CachedIngestFile = {
    v: 1,
    source_path: videoPath,
    word_to_clip_id: Array.from(wordToClipId.entries()).sort((a, b) => a[0] - b[0]),
    cached_at_ms: Date.now(),
  };
  await writeTextFile(getVideoIngestPath(siftPath, videoPath), JSON.stringify(envelope));
}

/** Ensure `<siftPath>/projects/` exists before the first engine save. */
export async function ensureProjectsDir(siftPath: string): Promise<void> {
  const dir = `${siftPath}/projects`;
  if (!(await exists(dir).catch(() => false))) {
    await mkdir(dir, { recursive: true });
  }
}
