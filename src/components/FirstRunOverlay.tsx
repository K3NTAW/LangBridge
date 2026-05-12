import { Sparkles, X } from "lucide-react";

import { modKeySymbol } from "../lib/modKey";
import { Kbd } from "./ui/Kbd";

interface Props {
  onDismiss: () => void;
}

/**
 * First-run checklist — Phase 1 “magic moment” orientation.
 */
export function FirstRunOverlay({ onDismiss }: Props) {
  const mod = modKeySymbol();
  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/75 p-6 backdrop-blur-sm"
      role="dialog"
      aria-modal
      aria-labelledby="cut-onboarding-title"
    >
      <div className="relative max-w-lg rounded-xl border border-violet-900/40 bg-zinc-950 px-6 py-6 shadow-2xl">
        <button
          type="button"
          onClick={onDismiss}
          className="absolute right-3 top-3 rounded-md border border-zinc-800 p-1.5 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
          aria-label="Close welcome"
        >
          <X className="h-4 w-4" strokeWidth={2} />
        </button>
        <div className="mb-4 flex items-center gap-2 text-violet-300">
          <Sparkles className="h-5 w-5" strokeWidth={2} />
          <h2 id="cut-onboarding-title" className="text-lg font-semibold text-zinc-100">
            Welcome to CUT
          </h2>
        </div>
        <ol className="list-decimal space-y-3 pl-5 text-sm leading-relaxed text-zinc-300">
          <li>
            Pick a <strong className="font-medium text-zinc-200">Whisper model</strong> in Transcript — tiny/base for a
            quick try; larger for cleaner captions.
          </li>
          <li>
            Use <strong className="font-medium text-zinc-200">Timeline → Media</strong> to import, then{" "}
            <strong className="font-medium text-zinc-200">Transcribe…</strong>, or open a video directly in Transcript.
          </li>
          <li>
            Click words to remove them; <strong className="font-medium text-zinc-200">Export</strong> writes H.264 via
            cut-ai. Optional <strong className="font-medium text-zinc-200">Captions</strong> (.srt / .vtt) stays synced
            to the cut.
          </li>
          <li>
            <strong className="font-medium text-zinc-200">Strip silence</strong> removes words that sit mostly in
            FFmpeg-detected dead air (see Transcript → Analyze & dead-air strip).
          </li>
          <li>
            Press <Kbd>{mod}</Kbd>
            <Kbd>K</Kbd> for the AI palette (plan stream). Hybrid sends planning to the stub cloud path while Whisper
            stays local.
          </li>
        </ol>
        <button
          type="button"
          onClick={onDismiss}
          className="mt-6 w-full rounded-lg bg-violet-600 py-2.5 text-sm font-medium text-white hover:bg-violet-500"
        >
          Get started
        </button>
      </div>
    </div>
  );
}
