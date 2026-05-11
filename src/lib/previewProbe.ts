import { invoke } from "@tauri-apps/api/core";

export interface PreviewProbePayload {
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
}

export async function previewProbe(path: string): Promise<PreviewProbePayload> {
  return await invoke<PreviewProbePayload>("preview_probe", { path });
}
