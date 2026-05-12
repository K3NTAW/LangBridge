import {
  ChevronRight,
  CornerDownLeft,
  Keyboard,
  Loader2,
  MessageSquare,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  AIServiceError,
  getAIClient,
  type PlanChunkPayload,
  type PlanContextPayload,
} from "../lib/aiClient";
import { modKeySymbol } from "../lib/modKey";
import { Kbd } from "./ui/Kbd";

interface Props {
  onClose: () => void;
  /** When null, natural-language planning is disabled (no project). */
  planContext: PlanContextPayload | null;
}

type PlanTurnStatus = "streaming" | "done" | "error";

interface PlanTurn {
  id: string;
  command: string;
  status: PlanTurnStatus;
  rationale: string;
  errorDetail?: string;
}

function summarizeChunk(chunk: PlanChunkPayload): string | null {
  if (chunk.type === "rationale") {
    const t = chunk.payload["text"];
    return typeof t === "string" ? t : null;
  }
  if (chunk.type === "question") {
    const p = chunk.payload["prompt"];
    return typeof p === "string" ? `? ${p}` : null;
  }
  if (chunk.type === "op") {
    return "[op]";
  }
  return null;
}

/**
 * AI command palette — **Phase 1:** streams `POST /v1/plan` (SSE) via [`getAIClient`].
 *
 * Local residency yields an `error` chunk with a helpful message; hybrid/cloud stream stubs.
 */
export function CommandPalette({ onClose, planContext }: Props) {
  const [prompt, setPrompt] = useState("");
  const [turns, setTurns] = useState<PlanTurn[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mod = modKeySymbol();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  async function runPlan(command: string) {
    if (!planContext) return;

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    const id = crypto.randomUUID();
    setTurns((t) => [...t, { id, command, status: "streaming", rationale: "" }]);

    const bump = (patch: Partial<PlanTurn>) => {
      setTurns((t) => t.map((row) => (row.id === id ? { ...row, ...patch } : row)));
    };

    try {
      for await (const chunk of getAIClient().plan(command, planContext, ac.signal)) {
        if (chunk.type === "error") {
          const msg = chunk.payload["message"];
          const code = chunk.payload["code"];
          const detail =
            typeof msg === "string"
              ? msg
              : typeof code === "string"
                ? code
                : "Planner error";
          bump({ status: "error", errorDetail: detail });
          return;
        }
        if (chunk.type === "done") {
          bump({ status: "done" });
          return;
        }
        const piece = summarizeChunk(chunk);
        if (piece) {
          setTurns((t) =>
            t.map((row) =>
              row.id === id ? { ...row, rationale: row.rationale + piece } : row,
            ),
          );
        }
      }
      bump({ status: "done" });
    } catch (e) {
      if (ac.signal.aborted) return;
      const detail =
        e instanceof AIServiceError ? e.detail : e instanceof Error ? e.message : String(e);
      bump({ status: "error", errorDetail: detail });
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const p = prompt.trim();
    if (!p) return;
    if (!planContext) return;
    setPrompt("");
    void runPlan(p);
  }

  return (
    <div
      role="dialog"
      aria-label="AI command palette"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 backdrop-blur-[2px] pt-[min(8rem,15vh)]"
      onClick={onClose}
    >
      <div
        className="w-[min(36rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-zinc-700/90 bg-zinc-900 shadow-2xl shadow-black/50 ring-1 ring-zinc-800/80"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-zinc-800/90 bg-zinc-950/90 px-3 py-2">
          <Sparkles className="h-4 w-4 shrink-0 text-orange-400/90" strokeWidth={2} />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
            Command
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
            aria-label="Close"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="flex items-center gap-2 px-3 py-2">
            <MessageSquare className="h-4 w-4 shrink-0 text-zinc-600" strokeWidth={2} />
            <input
              ref={inputRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={
                planContext
                  ? "e.g. cut silences over 0.8s in the second half"
                  : "Create or open a project first"
              }
              disabled={!planContext}
              className="min-w-0 flex-1 bg-transparent py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
        </form>

        {turns.length > 0 ? (
          <ul className="max-h-44 overflow-y-auto border-t border-zinc-800/80 bg-zinc-950/70 px-3 py-2 text-xs">
            {turns.slice(-6).map((turn) => (
              <li key={turn.id} className="border-b border-zinc-800/40 py-2 last:border-b-0">
                <div className="flex gap-2">
                  <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-600" strokeWidth={2} />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="text-zinc-300">{turn.command}</div>
                    {turn.rationale ? (
                      <div className="whitespace-pre-wrap font-mono text-[11px] leading-snug text-zinc-400">
                        {turn.rationale}
                      </div>
                    ) : null}
                    {turn.status === "streaming" ? (
                      <div className="flex items-center gap-1.5 text-[10px] text-zinc-500">
                        <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2} />
                        cut-ai…
                      </div>
                    ) : null}
                    {turn.status === "error" && turn.errorDetail ? (
                      <div className="text-[11px] text-amber-200/90">{turn.errorDetail}</div>
                    ) : null}
                    {turn.status === "done" && !turn.errorDetail ? (
                      <div className="text-[10px] text-zinc-600">cut-ai</div>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="border-t border-zinc-800/80 bg-zinc-950/70 px-3 py-3 text-xs text-zinc-500">
            <div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-600">
              <CornerDownLeft className="h-3 w-3" strokeWidth={2} />
              Examples
            </div>
            <ul className="space-y-2 leading-snug">
              <li className="flex gap-2">
                <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-700" strokeWidth={2} />
                Remove filler sounds between 5:00 and 8:00
              </li>
              <li className="flex gap-2">
                <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-700" strokeWidth={2} />
                Tighten pauses longer than 0.6s
              </li>
              <li className="flex gap-2">
                <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-700" strokeWidth={2} />
                Find where I talk about pricing
              </li>
            </ul>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 border-t border-zinc-800/90 bg-zinc-900/90 px-3 py-2 text-[11px] text-zinc-500">
          <span className="inline-flex items-center gap-1.5">
            <Keyboard className="h-3.5 w-3.5 text-zinc-600" strokeWidth={2} />
            <Kbd>Esc</Kbd>
            <span>close</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-flex items-center gap-0.5">
              <Kbd>{mod}</Kbd>
              <Kbd>K</Kbd>
            </span>
            <span>toggle</span>
          </span>
        </div>
      </div>
    </div>
  );
}
