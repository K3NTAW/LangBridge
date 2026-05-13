/**
 * Folder-as-project (Sift v0, Milestone A slice 1).
 *
 * The user picks a folder; we treat that folder as the workspace. State
 * persists in a hidden `.sift/` directory inside it — analogous to
 * `.git/`. There is no Open / Save As lifecycle for the user.
 *
 * **Slice 1 (this file):** open dialog + scan + `.sift/` directory
 * scaffold. Engine integration (`.sift/project.json` as the engine's
 * save path) and per-video transcription land in subsequent slices.
 */
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  BaseDirectory,
  exists,
  mkdir,
  readDir,
  stat,
  type DirEntry,
} from "@tauri-apps/plugin-fs";

/** Video file extensions Sift recognises when scanning a folder. */
export const VIDEO_EXTENSIONS = new Set([
  "mp4",
  "mov",
  "m4v",
  "mkv",
  "webm",
  "avi",
  "mts",
  "m2ts",
]);

/** One video file discovered inside the user's folder. */
export interface FolderVideo {
  /** Absolute path on disk. */
  path: string;
  /** Basename for display. */
  name: string;
  /** File size in bytes, when stat succeeds. */
  sizeBytes?: number;
  /** Last-modified epoch ms, when stat succeeds. */
  mtimeMs?: number;
}

/** Result of opening a folder. */
export interface FolderProject {
  /** Absolute path to the user's folder. */
  folderPath: string;
  /** Absolute path to the hidden `.sift/` directory inside the folder. */
  siftPath: string;
  /** Absolute path to `.sift/project.json` (engine save target). */
  projectFilePath: string;
  /** Video files we discovered on first scan, sorted alphabetically. */
  videos: FolderVideo[];
  /** True when `.sift/project.json` already existed before this open. */
  resumed: boolean;
}

/** True if a filename's extension is in {@link VIDEO_EXTENSIONS}. */
function isVideoFilename(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = name.slice(dot + 1).toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

function joinPath(folder: string, name: string): string {
  // Naive join — fine for absolute folder paths from the dialog plugin.
  if (folder.endsWith("/") || folder.endsWith("\\")) return folder + name;
  return `${folder}/${name}`;
}

/**
 * Scan a folder (non-recursive for v0) and return its video files,
 * sorted by name. Entries that aren't readable or aren't video files
 * are silently skipped.
 */
export async function scanFolderForVideos(folderPath: string): Promise<FolderVideo[]> {
  let entries: DirEntry[];
  try {
    entries = await readDir(folderPath);
  } catch (e) {
    throw new Error(
      `Could not read folder: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const results: FolderVideo[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (!isVideoFilename(entry.name)) continue;
    const path = joinPath(folderPath, entry.name);
    const video: FolderVideo = { path, name: entry.name };
    try {
      const s = await stat(path);
      if (typeof s.size === "number") video.sizeBytes = s.size;
      const m = s.mtime instanceof Date ? s.mtime.getTime() : null;
      if (m !== null && Number.isFinite(m)) video.mtimeMs = m;
    } catch {
      // stat failure is not fatal — show the entry without size/mtime.
    }
    results.push(video);
  }

  results.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
  return results;
}

/** Ensure `<folderPath>/.sift/` and its subdirectories exist. */
async function ensureSiftDirectory(folderPath: string): Promise<{
  siftPath: string;
  projectFilePath: string;
  resumed: boolean;
}> {
  const siftPath = joinPath(folderPath, ".sift");
  const projectFilePath = joinPath(siftPath, "project.json");

  const existedBefore = await exists(siftPath).catch(() => false);
  if (!existedBefore) {
    await mkdir(siftPath, { recursive: true });
  }
  // Subdirectories used by other Milestone A slices.
  for (const sub of ["transcripts", "cache", "exports"]) {
    const p = joinPath(siftPath, sub);
    if (!(await exists(p).catch(() => false))) {
      await mkdir(p, { recursive: true });
    }
  }

  const resumed = await exists(projectFilePath).catch(() => false);
  return { siftPath, projectFilePath, resumed };
}

/**
 * Prompt the user for a folder, scan it for videos, ensure `.sift/`
 * exists, and return the resulting {@link FolderProject}. Returns
 * `null` when the user cancels the dialog.
 *
 * Slice 1 deliberately stops short of touching the engine; engine
 * integration (`load`/`save` against `.sift/project.json`) lands in
 * slice 2 so we can ship this UI piece first without changing the
 * already-working engine path.
 */
export async function openFolderProject(): Promise<FolderProject | null> {
  const picked = await openDialog({
    directory: true,
    multiple: false,
    title: "Open Sift folder",
  });
  if (typeof picked !== "string") return null;

  const { siftPath, projectFilePath, resumed } = await ensureSiftDirectory(picked);
  const videos = await scanFolderForVideos(picked);

  return {
    folderPath: picked,
    siftPath,
    projectFilePath,
    videos,
    resumed,
  };
}

/**
 * Re-scan an already-opened folder for new videos the user may have
 * dropped in. Returns the updated video list.
 */
export async function refreshFolderVideos(folder: FolderProject): Promise<FolderVideo[]> {
  return scanFolderForVideos(folder.folderPath);
}

export { BaseDirectory };
