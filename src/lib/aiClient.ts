/**
 * HTTP client for the cut-ai service.
 *
 * In dev / demo, cut-ai runs as a separate process on a fixed port (see
 * `cut-ai/cut_ai/__main__.py::DEMO_PORT`). In production the Tauri host
 * launches cut-ai with an OS-assigned port and writes a discovery file —
 * a future patch will replace `DEFAULT_BASE_URL` with a function that
 * reads that file.
 */

import { iterateSseDataLines } from "./planSse";

const DEFAULT_BASE_URL =
  (import.meta.env.VITE_CUT_AI_URL as string | undefined) ??
  "http://127.0.0.1:8765";

/** Word-level timestamp from the AI service. */
export interface TranscriptWord {
  start_ticks: number;
  end_ticks: number;
  word: string;
  probability: number;
}

/** A contiguous chunk of speech (Whisper segment). */
export interface TranscriptSegment {
  start_ticks: number;
  end_ticks: number;
  text: string;
  speaker: string | null;
  avg_logprob: number | null;
  no_speech_prob: number | null;
}

/** Full transcript shape returned by `/v1/transcribe`. */
export interface Transcript {
  source_id: string;
  language: string;
  segments: TranscriptSegment[];
  words: TranscriptWord[];
}

export interface RecutRange {
  start_ticks: number;
  end_ticks: number;
}

export interface RecutResult {
  output_path: string;
  size_bytes: number;
  n_ranges: number;
}

/** Optional knobs for ``POST /v1/recut`` (1080p cap, burned-in subtitles). */
export interface RecutRequestOptions {
  signal?: AbortSignal;
  crf?: number;
  preset?: string;
  scale_max_height?: number | null;
  subtitle_path?: string | null;
  subtitle_force_style?: string | null;
}

/** ``POST /v1/postprocess`` — FFmpeg scenes + speaker labels (pyannote optional). */
export interface PostprocessResult {
  transcript: Transcript;
  scene_cut_ticks: number[];
  diarization_method: "heuristic_gap" | "pyannote";
  scene_detection: "ffmpeg" | "none";
}

/** ``POST /v1/silent_words`` — FFmpeg silencedetect overlap vs Whisper words. */
export interface SilentWordsResult {
  silence_interval_ticks: [number, number][];
  word_indices: number[];
}

export type DiarizationRequestMode = "auto" | "heuristic" | "pyannote";

export type Residency = "local" | "hybrid" | "cloud";

export type PlanChunkKind = "op" | "rationale" | "question" | "done" | "error";

/** Mirrors ``cut_ai.models.PlanContext`` — JSON body for ``POST /v1/plan``. */
export interface PlanContextPayload {
  project_id: string;
  sequence_id: string;
  selection?: string[];
  playhead_ticks?: number;
  scoped_window?: [number, number] | null;
  retrieved_segments?: unknown[];
  session_memory?: string[];
  data_residency: Residency;
}

/** One SSE JSON payload from ``POST /v1/plan`` (see ``PlanChunk`` in cut-ai). */
export interface PlanChunkPayload {
  type: PlanChunkKind;
  payload: Record<string, unknown>;
}

/**
 * Thrown when the cut-ai service responds with a non-2xx status. Carries
 * the parsed `detail` field if the body is JSON, or the raw text if not.
 */
export class AIServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(`cut-ai responded ${status}: ${detail}`);
    this.name = "AIServiceError";
  }
}

async function postJson<TReq, TRes>(
  url: string,
  body: TReq,
  signal?: AbortSignal,
): Promise<TRes> {
  // exactOptionalPropertyTypes: only set `signal` when actually provided
  // (the DOM types declare `signal: AbortSignal | null`, not `| undefined`).
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  if (signal !== undefined) init.signal = signal;
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    // fetch only throws on transport errors; most likely cut-ai isn't running.
    const msg = e instanceof Error ? e.message : String(e);
    throw new AIServiceError(0, `transport error: ${msg}`);
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const j = (await res.json()) as { detail?: string };
      if (typeof j.detail === "string") detail = j.detail;
    } catch {
      try {
        detail = await res.text();
      } catch {
        // fall through with statusText
      }
    }
    throw new AIServiceError(res.status, detail);
  }
  return (await res.json()) as TRes;
}

/**
 * Options for {@link AIClient.transcribe}.
 */
export interface TranscribeOptions {
  signal?: AbortSignal;
  /** faster-whisper model id (e.g. base, small, large-v3). Sent as ``whisper_model`` to cut-ai. */
  whisper_model?: string;
}

export interface AIClient {
  /** Probe `/v1/info` to confirm the service is reachable. */
  ping(): Promise<{ service: string; version: string; spec_version: string }>;

  /**
   * Run Whisper on a media file. Synchronous: resolves once the
   * transcript is fully formed.
   */
  transcribe(
    mediaPath: string,
    residency?: Residency,
    options?: TranscribeOptions,
  ): Promise<Transcript>;

  /**
   * Run an FFmpeg recut keeping only the listed ranges (in source-time
   * ticks). Resolves once ffmpeg returns. The output file is written to
   * `outputPath`; the resolved `RecutResult` includes its size.
   */
  recut(
    inputPath: string,
    outputPath: string,
    keptRanges: RecutRange[],
    options?: RecutRequestOptions,
  ): Promise<RecutResult>;

  /**
   * Scene-cut ticks (FFmpeg) + speaker labels (pyannote optional).
   */
  postprocess(
    mediaPath: string,
    transcript: Transcript,
    options?: {
      signal?: AbortSignal;
      scene_threshold?: number;
      speaker_gap_seconds?: number;
      diarization?: DiarizationRequestMode;
    },
  ): Promise<PostprocessResult>;

  /** FFmpeg silencedetect vs Whisper word timings → indices to strip. */
  silentWords(
    mediaPath: string,
    transcript: Transcript,
    options?: {
      signal?: AbortSignal;
      noise_db?: number;
      min_duration_s?: number;
      overlap_ratio?: number;
    },
  ): Promise<SilentWordsResult>;

  /**
   * Stream edit-plan chunks from ``POST /v1/plan`` (SSE). Yields parsed
   * [`PlanChunkPayload`] objects until the stream ends or the signal aborts.
   */
  plan(
    command: string,
    ctx: PlanContextPayload,
    signal?: AbortSignal,
  ): AsyncGenerator<PlanChunkPayload, void, undefined>;
}

class HttpAIClient implements AIClient {
  constructor(private readonly baseUrl: string) {}

  async ping(): Promise<{ service: string; version: string; spec_version: string }> {
    const res = await fetch(`${this.baseUrl}/v1/info`);
    if (!res.ok) throw new AIServiceError(res.status, res.statusText);
    return (await res.json()) as { service: string; version: string; spec_version: string };
  }

  async transcribe(
    mediaPath: string,
    residency: Residency = "local",
    options?: TranscribeOptions,
  ): Promise<Transcript> {
    const body: {
      media_path: string;
      residency: Residency;
      whisper_model?: string;
    } = { media_path: mediaPath, residency };
    if (options?.whisper_model !== undefined && options.whisper_model !== "") {
      body.whisper_model = options.whisper_model;
    }
    return postJson<typeof body, Transcript>(
      `${this.baseUrl}/v1/transcribe`,
      body,
      options?.signal,
    );
  }

  async recut(
    inputPath: string,
    outputPath: string,
    keptRanges: RecutRange[],
    options?: RecutRequestOptions,
  ): Promise<RecutResult> {
    const body: {
      input_path: string;
      output_path: string;
      kept_ranges: RecutRange[];
      crf?: number;
      preset?: string;
      scale_max_height?: number;
      subtitle_path?: string;
      subtitle_force_style?: string;
    } = {
      input_path: inputPath,
      output_path: outputPath,
      kept_ranges: keptRanges,
    };
    const o = options;
    if (o?.crf !== undefined) body.crf = o.crf;
    if (o?.preset !== undefined) body.preset = o.preset;
    if (o?.scale_max_height != null && o.scale_max_height > 0) {
      body.scale_max_height = o.scale_max_height;
    }
    if (o?.subtitle_path != null && o.subtitle_path.length > 0) {
      body.subtitle_path = o.subtitle_path;
    }
    if (o?.subtitle_force_style != null && o.subtitle_force_style.length > 0) {
      body.subtitle_force_style = o.subtitle_force_style;
    }
    return postJson<typeof body, RecutResult>(
      `${this.baseUrl}/v1/recut`,
      body,
      o?.signal,
    );
  }

  async postprocess(
    mediaPath: string,
    transcript: Transcript,
    opt?: {
      signal?: AbortSignal;
      scene_threshold?: number;
      speaker_gap_seconds?: number;
      diarization?: DiarizationRequestMode;
    },
  ): Promise<PostprocessResult> {
    const body: {
      media_path: string;
      transcript: Transcript;
      scene_threshold?: number;
      speaker_gap_seconds?: number;
      diarization?: DiarizationRequestMode;
    } = { media_path: mediaPath, transcript };
    if (opt?.scene_threshold !== undefined) body.scene_threshold = opt.scene_threshold;
    if (opt?.speaker_gap_seconds !== undefined) body.speaker_gap_seconds = opt.speaker_gap_seconds;
    if (opt?.diarization !== undefined) body.diarization = opt.diarization;
    return postJson<typeof body, PostprocessResult>(
      `${this.baseUrl}/v1/postprocess`,
      body,
      opt?.signal,
    );
  }

  async silentWords(
    mediaPath: string,
    transcript: Transcript,
    opt?: {
      signal?: AbortSignal;
      noise_db?: number;
      min_duration_s?: number;
      overlap_ratio?: number;
    },
  ): Promise<SilentWordsResult> {
    const body: {
      media_path: string;
      transcript: Transcript;
      noise_db?: number;
      min_duration_s?: number;
      overlap_ratio?: number;
    } = { media_path: mediaPath, transcript };
    if (opt?.noise_db !== undefined) body.noise_db = opt.noise_db;
    if (opt?.min_duration_s !== undefined) body.min_duration_s = opt.min_duration_s;
    if (opt?.overlap_ratio !== undefined) body.overlap_ratio = opt.overlap_ratio;
    return postJson<typeof body, SilentWordsResult>(
      `${this.baseUrl}/v1/silent_words`,
      body,
      opt?.signal,
    );
  }

  async *plan(
    command: string,
    ctx: PlanContextPayload,
    signal?: AbortSignal,
  ): AsyncGenerator<PlanChunkPayload, void, undefined> {
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ command, ctx }),
    };
    if (signal !== undefined) init.signal = signal;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/plan`, init);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new AIServiceError(0, `transport error: ${msg}`);
    }

    if (!res.ok) {
      let detail = res.statusText;
      try {
        const j = (await res.json()) as { detail?: string };
        if (typeof j.detail === "string") detail = j.detail;
      } catch {
        try {
          detail = await res.text();
        } catch {
          // keep statusText
        }
      }
      throw new AIServiceError(res.status, detail);
    }

    const body = res.body;
    if (body === null) {
      throw new AIServiceError(0, "cut-ai plan: empty response body");
    }

    const reader = body.getReader();
    try {
      for await (const ev of iterateSseDataLines(reader)) {
        let row: unknown;
        try {
          row = JSON.parse(ev.data) as unknown;
        } catch {
          continue;
        }
        if (
          typeof row === "object" &&
          row !== null &&
          "type" in row &&
          typeof (row as { type: unknown }).type === "string" &&
          "payload" in row &&
          typeof (row as { payload: unknown }).payload === "object" &&
          (row as { payload: unknown }).payload !== null
        ) {
          yield row as PlanChunkPayload;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

let _client: AIClient | null = null;

/** Singleton. Replace via {@link setAIClient} in tests. */
export function getAIClient(): AIClient {
  if (_client === null) _client = new HttpAIClient(DEFAULT_BASE_URL);
  return _client;
}

export function setAIClient(c: AIClient): void {
  _client = c;
}
