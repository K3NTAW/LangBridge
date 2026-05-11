import {
  ChevronRight,
  CornerDownLeft,
  Keyboard,
  MessageSquare,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { modKeySymbol } from "../lib/modKey";
import { Kbd } from "./ui/Kbd";

interface Props {
  onClose: () => void;
}

/**
 * AI command palette.
 *
 * **Today:** UI shell. Submitting echoes the prompt into the panel as a
 * stub "plan" (no AI call yet). When `cut-ai` is wired up this submits
 * to `POST /v1/plan` and renders streaming `PlanChunk` events as a diff.
 */
export function CommandPalette({ onClose }: Props) {
  const [prompt, setPrompt] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const mod = modKeySymbol();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const p = prompt.trim();
    if (!p) return;
    setHistory((h) => [...h, p]);
    setPrompt("");
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
              placeholder="e.g. cut silences over 0.8s in the second half"
              className="min-w-0 flex-1 bg-transparent py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
            />
          </div>
        </form>

        {history.length > 0 ? (
          <ul className="max-h-40 overflow-y-auto border-t border-zinc-800/80 bg-zinc-950/70 px-3 py-2 text-xs text-zinc-400">
            {history.slice(-5).map((p, i) => (
              <li key={i} className="flex gap-2 py-1.5">
                <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-600" strokeWidth={2} />
                <span className="text-zinc-300">{p}</span>
                <span className="ml-auto shrink-0 text-[10px] text-zinc-600">Planner offline</span>
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
