/**
 * Lightweight sift-ai reachability probe.
 *
 * Pings `/v1/info` (cheap, never blocks) on a small interval. Components
 * can subscribe via the hook to render a status indicator and surface a
 * "service not running" banner *before* the user clicks something that
 * would otherwise fail with a generic transport error.
 */
import { useEffect, useRef, useState } from "react";

export type SiftAiHealth = "unknown" | "ok" | "down";

interface HealthResult {
  health: SiftAiHealth;
  /** Last successful info() response, if any. */
  version?: string;
  /** Last error text we got from the probe, if any. */
  error?: string;
  /** Force a fresh probe right now. */
  refresh: () => void;
}

const DEFAULT_BASE_URL =
  (import.meta.env.VITE_SIFT_AI_URL as string | undefined) ?? "http://127.0.0.1:8765";

async function probeOnce(
  baseUrl: string,
  signal: AbortSignal,
): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${baseUrl}/v1/info`, { signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { version?: string };
    return { ok: true, version: body.version ?? "" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Health-check hook. Probes once on mount, then every `intervalMs`
 * (default 15 s). State transitions are debounced — a single missed
 * probe doesn't flap to `"down"`; two in a row does.
 */
export function useSiftAiHealth(intervalMs = 15_000): HealthResult {
  const [health, setHealth] = useState<SiftAiHealth>("unknown");
  const [version, setVersion] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const consecutiveFailuresRef = useRef(0);
  const refreshTokenRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();

    const tick = async () => {
      const r = await probeOnce(DEFAULT_BASE_URL, ctrl.signal);
      if (cancelled) return;
      if (r.ok) {
        consecutiveFailuresRef.current = 0;
        setHealth("ok");
        setVersion(r.version);
        setError(undefined);
      } else {
        consecutiveFailuresRef.current += 1;
        // Require two consecutive failures before flipping to "down"
        // — single-probe flakiness shouldn't alarm the user.
        if (consecutiveFailuresRef.current >= 2) {
          setHealth("down");
          setError(r.error);
        }
      }
    };

    void tick();
    const id = window.setInterval(() => {
      void tick();
    }, intervalMs);

    return () => {
      cancelled = true;
      ctrl.abort();
      window.clearInterval(id);
    };
    // refreshTokenRef.current is in the deps as a no-op trigger via state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, refreshTokenRef.current]);

  const refresh = () => {
    refreshTokenRef.current += 1;
    // Force a re-render so the effect re-subscribes.
    setHealth((h) => (h === "down" ? "unknown" : h));
  };

  const result: HealthResult = { health, refresh };
  if (version !== undefined) result.version = version;
  if (error !== undefined) result.error = error;
  return result;
}
