import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

import { framePeriodTicks, Rates, secondsToTicksApprox, type Tick } from "./time";

interface Args {
  durationSeconds: number | null;
  playheadTicks: Tick;
  setPlayheadTicks: Dispatch<SetStateAction<Tick>>;
}

/** Low-FPS playback (~24 Hz) advancing integer ticks; stops at duration. */
export function useTimelineTransport({ durationSeconds, playheadTicks, setPlayheadTicks }: Args) {
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(playing);
  playingRef.current = playing;

  useEffect(() => {
    if (!playing || durationSeconds === null || durationSeconds <= 0) return;

    const period = framePeriodTicks(Rates.fps24);
    if (period === null) return;

    const maxT = secondsToTicksApprox(durationSeconds);
    const ms = 1000 / (Rates.fps24.num / Rates.fps24.den);

    const id = window.setInterval(() => {
      if (!playingRef.current) return;
      setPlayheadTicks((t) => {
        const next = t + period;
        if (next >= maxT) {
          playingRef.current = false;
          queueMicrotask(() => setPlaying(false));
          return maxT;
        }
        return next;
      });
    }, ms);

    return () => window.clearInterval(id);
  }, [playing, durationSeconds, setPlayheadTicks]);

  useEffect(() => {
    if (durationSeconds === null || durationSeconds <= 0) return;
    const maxT = secondsToTicksApprox(durationSeconds);
    if (playheadTicks >= maxT && playing) {
      setPlaying(false);
    }
  }, [durationSeconds, playheadTicks, playing]);

  const togglePlaying = useCallback(() => {
    if (durationSeconds === null || durationSeconds <= 0) return;
    const maxT = secondsToTicksApprox(durationSeconds);
    setPlaying((p) => {
      if (p) return false;
      setPlayheadTicks((t) => (t >= maxT ? 0n : t));
      return true;
    });
  }, [durationSeconds, setPlayheadTicks]);

  return { playing, setPlaying, togglePlaying };
}
