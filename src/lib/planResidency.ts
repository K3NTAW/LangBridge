import type { Residency } from "./aiClient";

/** Parse `VITE_PLAN_DATA_RESIDENCY` for Cmd‑K (`POST /v1/plan`) only. */
export function parsePlanDataResidency(raw: string | undefined): Residency {
  const t = raw?.trim().toLowerCase();
  if (t === "local" || t === "hybrid" || t === "cloud") return t;
  return "hybrid";
}

/**
 * Residency sent in [`PlanContextPayload`] for the command palette.
 *
 * Defaults to **`hybrid`** so planning hits the cloud stub while Whisper/transcribe
 * stays local when callers pass `residency: "local"`.
 */
export function planCommandDataResidency(): Residency {
  return parsePlanDataResidency(import.meta.env.VITE_PLAN_DATA_RESIDENCY as string | undefined);
}
