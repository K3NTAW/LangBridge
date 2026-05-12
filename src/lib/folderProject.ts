/**
 * Folder-as-project (Sift v0).
 *
 * The user picks a folder; we treat that folder as the project. State
 * persists in a hidden `.sift/` directory inside it — analogous to
 * `.git/`. There is no Open / Save As lifecycle; saves happen
 * implicitly as ops are applied.
 *
 * This module is the shell-side counterpart to the engine's project
 * file I/O (see `sift-engine/src/file.rs`). The engine's `save` / `load`
 * already take a path argument — we just feed it `<folder>/.sift/project.json`.
 *
 * Status: stubs. Implementation lands in Milestone A.
 */
import type { EngineClient, LoadResult, NewResult } from "./engineClient";

/** Video file extensions we recognise when scanning a folder. */
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

/** One video file inside the user's folder. */
export interface FolderVideo {
  /** Absolute path on disk. */
  path: string;
  /** Basename for display. */
  name: string;
  /** File size in bytes, when known. */
  sizeBytes?: number;
  /** Last-modified epoch ms, when known. */
  mtimeMs?: number;
}

/** Result of opening a folder. */
export interface FolderProject {
  /** Absolute path to the user's folder. */
  folderPath: string;
  /** Absolute path to the hidden `.sift/` directory inside the folder. */
  siftPath: string;
  /** Absolute path to `.sift/project.json`. */
  projectFilePath: string;
  /** Video files we discovered on first scan. */
  videos: FolderVideo[];
  /** Engine project id from a `new` or `load` call. */
  projectId: string;
  /** True when the folder was already a Sift project (had .sift/project.json). */
  resumed: boolean;
}

/**
 * Prompt the user for a folder, scan it for videos, ensure `.sift/`
 * exists, and either resume the existing project or initialise a new
 * one in the engine.
 *
 * **Not yet implemented.** Milestone A wires this up.
 */
export async function openFolderProject(_engine: EngineClient): Promise<FolderProject | null> {
  throw new Error("openFolderProject: not implemented yet (Milestone A)");
}

/**
 * Scan a folder for supported video files. Does not recurse for now —
 * v0 stays flat; nested folders are a v1 question.
 *
 * **Not yet implemented.**
 */
export async function scanFolderForVideos(_folderPath: string): Promise<FolderVideo[]> {
  throw new Error("scanFolderForVideos: not implemented yet (Milestone A)");
}

/** Initialise `.sift/` and create a fresh engine project pointing at it. */
export async function initNewSiftProject(
  _engine: EngineClient,
  _folderPath: string,
): Promise<NewResult> {
  throw new Error("initNewSiftProject: not implemented yet (Milestone A)");
}

/** Resume an existing Sift project: load `.sift/project.json` into the engine. */
export async function resumeSiftProject(
  _engine: EngineClient,
  _folderPath: string,
): Promise<LoadResult> {
  throw new Error("resumeSiftProject: not implemented yet (Milestone A)");
}
