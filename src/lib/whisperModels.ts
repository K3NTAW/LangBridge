/** faster-whisper model presets shown in the transcript UI (must stay synced with server acceptance rules). */

export const DEFAULT_WHISPER_MODEL = "base";

export const WHISPER_MODEL_STORAGE_KEY = "cut-app-whisper-model";

export interface WhisperModelOption {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
}

/** Curated ids — server accepts any ``/^[\w.\-/]+$/`` HuggingFace-style id up to 96 chars. */
export const WHISPER_MODEL_OPTIONS: readonly WhisperModelOption[] = [
  { id: "tiny", label: "Tiny", hint: "~75 MB · fastest · rough captions" },
  { id: "tiny.en", label: "Tiny (EN)", hint: "English-only tiny" },
  { id: "base", label: "Base", hint: "~140 MB · balanced default" },
  { id: "base.en", label: "Base (EN)", hint: "English-only base" },
  { id: "small", label: "Small", hint: "~460 MB · clearer names & jargon" },
  { id: "small.en", label: "Small (EN)", hint: "English-only small" },
  { id: "medium", label: "Medium", hint: "~1.5 GB · strong accuracy" },
  { id: "medium.en", label: "Medium (EN)", hint: "English-only medium" },
  { id: "large-v3", label: "Large v3", hint: "~3 GB · best quality · heavy GPU/CPU" },
  {
    id: "distil-large-v3",
    label: "Distil large v3",
    hint: "faster large-class · moderate VRAM",
  },
];

const KNOWN_IDS = new Set(WHISPER_MODEL_OPTIONS.map((o) => o.id));

/** Loose validation aligned with cut-ai ``normalize_whisper_model_override``. */
export function isLikelyWhisperModelId(id: string): boolean {
  if (id.length <= 0 || id.length > 96 || id.includes("..")) return false;
  return /^[\w.\-/]+$/.test(id);
}

/** Restore last-used model from ``localStorage``. Returns ``""`` until the user picks one (onboarding). */
export function loadStoredWhisperModel(): string {
  try {
    const raw = localStorage.getItem(WHISPER_MODEL_STORAGE_KEY);
    if (raw === null) return "";
    const t = raw.trim();
    if (!t) return "";
    if (KNOWN_IDS.has(t) || isLikelyWhisperModelId(t)) return t;
    return "";
  } catch {
    return "";
  }
}

export function saveStoredWhisperModel(id: string): void {
  try {
    const t = id.trim();
    if (!t) {
      localStorage.removeItem(WHISPER_MODEL_STORAGE_KEY);
      return;
    }
    localStorage.setItem(WHISPER_MODEL_STORAGE_KEY, t);
  } catch {
    /* ignore */
  }
}
