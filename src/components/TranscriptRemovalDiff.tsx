import { GitCompare, X } from "lucide-react";

import type { TranscriptWord } from "../lib/aiClient";
import { cn } from "../lib/cn";

interface Props {
  words: readonly TranscriptWord[];
  /** Indices removed from the cut (filler auto-clean + manual deletes). */
  deleted: ReadonlySet<number>;
  onClose: () => void;
}

/**
 * Side-by-side diff: **original** transcript vs **current cut** (removed words struck through).
 */
export function TranscriptRemovalDiff({ words, deleted, onClose }: Props) {
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal
      aria-labelledby="cut-removal-diff-title"
    >
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-zinc-700 bg-[var(--cut-bg-deep)] shadow-2xl">
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-800 px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-200">
            <GitCompare className="h-4 w-4 text-violet-400" strokeWidth={2} />
            <span id="cut-removal-diff-title">Removal diff</span>
            <span className="text-[11px] font-normal text-zinc-500">
              {deleted.size} token{deleted.size === 1 ? "" : "s"} removed
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-700 p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            aria-label="Close diff"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 divide-y divide-zinc-800 md:grid-cols-2 md:divide-x md:divide-y-0">
          <section className="flex min-h-0 flex-col overflow-hidden">
            <div className="shrink-0 bg-zinc-900/50 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
              Original
            </div>
            <div className="min-h-[12rem] overflow-y-auto px-4 py-3 text-[14px] leading-relaxed text-zinc-100">
              <WordDiffColumn deleted={deleted} mode="original" words={words} />
            </div>
          </section>
          <section className="flex min-h-0 flex-col overflow-hidden">
            <div className="shrink-0 bg-zinc-900/50 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
              Current cut
            </div>
            <div className="min-h-[12rem] overflow-y-auto px-4 py-3 text-[14px] leading-relaxed text-zinc-100">
              <WordDiffColumn deleted={deleted} mode="current" words={words} />
            </div>
          </section>
        </div>
        <footer className="shrink-0 border-t border-zinc-800 px-4 py-2 text-[11px] text-zinc-600">
          Removed words include filler auto-clean and clicks. Undo restores them when the engine allows.
        </footer>
      </div>
    </div>
  );
}

function WordDiffColumn({
  words,
  deleted,
  mode,
}: {
  words: readonly TranscriptWord[];
  deleted: ReadonlySet<number>;
  mode: "original" | "current";
}) {
  return (
    <p className="inline leading-relaxed">
      {words.map((w, i) => {
        const isDel = deleted.has(i);
        const raw = w.word;
        const spacer = raw.startsWith("'") || raw.startsWith(".") ? "" : i === 0 ? "" : " ";
        if (mode === "original") {
          return (
            <span key={`o-${i}`}>
              {spacer}
              <span
                className={cn(
                  isDel && "rounded-sm bg-rose-950/55 text-rose-100 line-through decoration-rose-400/80",
                  !isDel && "text-zinc-100",
                )}
              >
                {raw}
              </span>
            </span>
          );
        }
        if (isDel) return null;
        return (
          <span key={`c-${i}`} className="text-emerald-50">
            {spacer}
            {raw}
          </span>
        );
      })}
    </p>
  );
}
