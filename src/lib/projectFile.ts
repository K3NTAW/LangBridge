/**
 * Helpers for the File → New / Open / Save flow.
 *
 * These wrap Tauri's dialog plugin so the call sites in App.tsx /
 * useEngineProject stay readable. Each helper resolves to the chosen
 * path or `null` when the user cancels.
 */
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

const PROJECT_EXT = "cut";

/**
 * Show a "Save Project As…" dialog. Returns the chosen path or `null`
 * when the user dismisses. Adds the `.cut` extension if the user
 * didn't type one.
 */
export async function pickSavePath(suggested = "Untitled"): Promise<string | null> {
  const path = await saveDialog({
    title: "Save Sift Project",
    defaultPath: `${suggested}.${PROJECT_EXT}`,
    filters: [{ name: "Sift Project", extensions: [PROJECT_EXT] }],
  });
  if (!path) return null;
  return path.endsWith(`.${PROJECT_EXT}`) ? path : `${path}.${PROJECT_EXT}`;
}

/** Show an "Open Project…" dialog. Returns the chosen path or `null`. */
export async function pickOpenPath(): Promise<string | null> {
  const path = await openDialog({
    title: "Open Sift Project",
    multiple: false,
    directory: false,
    filters: [{ name: "Sift Project", extensions: [PROJECT_EXT] }],
  });
  if (!path) return null;
  if (Array.isArray(path)) return path[0] ?? null;
  return path;
}
