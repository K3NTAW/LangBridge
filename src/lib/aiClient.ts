/**
 * HTTP client for the cut-ai service.
 *
 * In dev / demo, cut-ai runs as a separate process on a fixed port (see
 * `cut-ai/cut_ai/__main__.py::DEMO_PORT`). In production the Tauri host
 * launches cut-ai with an OS-assigned port and writes a discovery file —
 * a future patch will replace `DEFAULT_BASE_URL` with a function that
 * reads that file.
 */

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

export type Residency = "local" | "hybrid" | "cloud";

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
    signal?: AbortSignal,
  ): Promise<RecutResult>;
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
    signal?: AbortSignal,
  ): Promise<RecutResult> {
    return postJson<
      {
        input_path: string;
        output_path: string;
        kept_ranges: RecutRange[];
      },
      RecutResult
    >(
      `${this.baseUrl}/v1/recut`,
      { input_path: inputPath, output_path: outputPath, kept_ranges: keptRanges },
      signal,
    );
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
