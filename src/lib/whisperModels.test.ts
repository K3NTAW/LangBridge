import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isLikelyWhisperModelId,
  loadStoredWhisperModel,
  saveStoredWhisperModel,
  WHISPER_MODEL_STORAGE_KEY,
} from "./whisperModels";

describe("isLikelyWhisperModelId", () => {
  it("accepts common ids", () => {
    expect(isLikelyWhisperModelId("large-v3")).toBe(true);
    expect(isLikelyWhisperModelId("Systran/faster-whisper-medium")).toBe(true);
  });

  it("rejects injection-ish strings", () => {
    expect(isLikelyWhisperModelId("../etc/passwd")).toBe(false);
    expect(isLikelyWhisperModelId("")).toBe(false);
  });
});

describe("localStorage round-trip", () => {
  let store: Record<string, string>;

  beforeEach(() => {
    store = {};
    vi.stubGlobal(
      "localStorage",
      {
        getItem: (key: string) => store[key] ?? null,
        setItem: (key: string, value: string) => {
          store[key] = value;
        },
        removeItem: (key: string) => {
          delete store[key];
        },
        clear: () => {
          store = {};
        },
        key: (i: number) => Object.keys(store)[i] ?? null,
        get length() {
          return Object.keys(store).length;
        },
      } satisfies Storage,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults when unset", () => {
    expect(loadStoredWhisperModel()).toBe("");
  });

  it("persists a known model id", () => {
    saveStoredWhisperModel("small");
    expect(loadStoredWhisperModel()).toBe("small");
    localStorage.removeItem(WHISPER_MODEL_STORAGE_KEY);
    expect(loadStoredWhisperModel()).toBe("");
  });

  it("clears storage when saving empty", () => {
    saveStoredWhisperModel("tiny");
    saveStoredWhisperModel("  ");
    expect(loadStoredWhisperModel()).toBe("");
  });
});
