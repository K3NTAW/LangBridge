/**
 * Media pool pane (left sidebar).
 *
 * **Today:** import a video file into the engine as one full-length clip
 * on the primary video track (empty timeline only). Media list UI comes later.
 */
import { AlertTriangle, HardDrive, Info, Loader2, Mic, Upload } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useState } from "react";

import { cn } from "../lib/cn";
import { modKeySymbol } from "../lib/modKey";
import { importMediaFullClip } from "../lib/simpleMediaImport";
import type { UseEngineProject } from "../lib/useEngineProject";

function mediaBasename(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i === -1 ? path : path.slice(i + 1);
}

interface Props {
  project: UseEngineProject;
  /** After Media Pool import, jump to Transcript and run Whisper on this path (replaces timeline). */
  onRequestTranscribe?: (mediaPath: string) => void;
  /** False until user picks a Whisper model (Transcript tab). */
  whisperModelSelected?: boolean;
}

type ImportPhase = "idle" | "batch" | "proxy";

export function MediaPoolPane({
  project,
  onRequestTranscribe,
  whisperModelSelected = false,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [importPhase, setImportPhase] = useState<ImportPhase>("idle");
  const [localError, setLocalError] = useState<string | null>(null);
  const [lastPath, setLastPath] = useState<string | null>(null);
  const [importFileLabel, setImportFileLabel] = useState<string | null>(null);
  /** After import, proxy generation failed — timeline is still valid; scrub uses full-res decode. */
  const [proxyFallbackNotice, setProxyFallbackNotice] = useState(false);

  const onImport = useCallback(async () => {
    if (!project.head) return;
    setLocalError(null);
    setProxyFallbackNotice(false);
    const picked = await openDialog({
      multiple: false,
      directory: false,
      title: "Import media",
      filters: [
        { name: "Video", extensions: ["mp4", "mov", "m4v", "mkv", "webm", "avi"] },
        { name: "Any", extensions: ["*"] },
      ],
    });
    if (typeof picked !== "string") return;
    setImportFileLabel(mediaBasename(picked));
    setBusy(true);
    setImportPhase("batch");
    try {
      const r = await importMediaFullClip(picked, (ops) => project.applyBatch(ops), {
        onAfterBatch: () => setImportPhase("proxy"),
        proxyGenerate: async (sourceId) => {
          const out = await project.proxyGenerateOptional(sourceId as unknown as string);
          return out !== null;
        },
      });
      if (!r.ok) {
        setLocalError(r.message);
        return;
      }
      setLastPath(picked);
      setProxyFallbackNotice(r.proxyOutcome === "failed");
    } finally {
      setImportPhase("idle");
      setBusy(false);
      setImportFileLabel(null);
    }
  }, [project]);

  const hasProject = project.head !== null;
  const disabled = !hasProject || project.busy || busy;
  const mod = modKeySymbol();

  return (
    <div className="flex h-full flex-col border-r border-zinc-800/70 bg-[var(--cut-bg-deep)]">
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-zinc-800/80 px-2.5">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          <HardDrive className="h-3.5 w-3.5 text-zinc-600" strokeWidth={2} />
          Media
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => void onImport()}
          className={cn(
            "inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors",
            disabled
              ? "cursor-not-allowed border-transparent bg-zinc-900/40 text-zinc-600 opacity-50"
              : "border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-zinc-600 hover:bg-zinc-800",
          )}
          title={hasProject ? "Import one clip (empty video track only)" : "Create or open a project first"}
        >
          <Upload className="h-3.5 w-3.5" strokeWidth={2} />
          Import
        </button>
      </div>
      <div className="flex flex-1 flex-col gap-2 overflow-auto px-2.5 py-3 text-xs">
        {localError ? (
          <div
            role="status"
            aria-live="polite"
            className="flex gap-2 rounded-md border border-amber-900/45 bg-amber-950/25 px-2.5 py-2 text-[11px] text-amber-100/95"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" strokeWidth={2} />
            <div className="min-w-0 flex-1 space-y-1.5">
              <span className="block">{localError}</span>
              <button
                type="button"
                onClick={() => setLocalError(null)}
                className="text-[10px] font-medium text-amber-200/90 underline decoration-amber-600/80 underline-offset-2 hover:text-amber-50"
              >
                Dismiss
              </button>
            </div>
          </div>
        ) : null}
        {proxyFallbackNotice ? (
          <div
            role="status"
            aria-live="polite"
            className="flex gap-2 rounded-md border border-sky-900/40 bg-sky-950/20 px-2.5 py-2 text-[11px] text-sky-50/95"
          >
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-400/90" strokeWidth={2} />
            <div className="min-w-0 flex-1 space-y-1.5">
              <span className="block leading-snug">
                Preview proxy was not created — scrub uses <strong className="font-semibold">full-resolution</strong> decode.
                Import succeeded.
              </span>
              <p className="text-[10px] leading-snug text-zinc-500">
                Ensure FFmpeg is on the engine host PATH and there is disk space for temp proxies.
              </p>
              <button
                type="button"
                onClick={() => setProxyFallbackNotice(false)}
                className="text-[10px] font-medium text-sky-200/90 underline decoration-sky-700/80 underline-offset-2 hover:text-sky-50"
              >
                Dismiss
              </button>
            </div>
          </div>
        ) : null}
        {busy && importPhase !== "idle" ? (
          <div className="flex flex-col gap-1 rounded-md border border-zinc-700/60 bg-zinc-900/55 px-2.5 py-2 text-[11px] text-zinc-400">
            <div className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-zinc-500" strokeWidth={2} />
              <span>
                {importFileLabel ? (
                  <span className="font-mono text-zinc-300">{importFileLabel}</span>
                ) : null}
                {importFileLabel ? <span className="text-zinc-600"> · </span> : null}
                {importPhase === "batch" ? (
                  <>
                    Importing timeline <span className="text-zinc-600">(1/2)</span>
                  </>
                ) : (
                  <>
                    Generating preview proxy <span className="text-zinc-600">(2/2)</span>
                  </>
                )}
              </span>
            </div>
            <p className="pl-[calc(0.875rem+10px)] text-[10px] leading-snug text-zinc-600">
              FFmpeg builds a smaller H.264 proxy for scrub when possible; otherwise preview stays on the original file.
            </p>
          </div>
        ) : null}
        {lastPath ? (
          <div className="space-y-3 rounded-lg border border-zinc-800/80 bg-zinc-950/80 p-2.5">
            <div>
              <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-600">
                <HardDrive className="h-3 w-3" strokeWidth={2} />
                Last import
              </div>
              <div className="mt-1 truncate font-mono text-[11px] text-zinc-300" title={lastPath}>
                {lastPath.split(/[/\\]/).pop()}
              </div>
            </div>
            {onRequestTranscribe ? (
              <button
                type="button"
                disabled={busy || project.busy || !whisperModelSelected}
                onClick={() => onRequestTranscribe(lastPath)}
                className="flex w-full items-center justify-center gap-2 rounded-md border border-violet-800/45 bg-violet-950/35 px-2 py-2 text-[11px] font-medium text-violet-100 hover:bg-violet-900/45 disabled:cursor-not-allowed disabled:opacity-40"
                title={
                  whisperModelSelected
                    ? "Open Transcript and run Whisper (replaces timeline with word clips)."
                    : "Open Transcript and choose a Whisper model first."
                }
              >
                <Mic className="h-3.5 w-3.5" strokeWidth={2} />
                Transcribe
              </button>
            ) : null}
          </div>
        ) : !hasProject ? (
          <div className="rounded-lg border border-dashed border-zinc-800/90 bg-zinc-950/40 px-3 py-6 text-center text-[11px] leading-relaxed text-zinc-600">
            <HardDrive className="mx-auto mb-2 h-8 w-8 text-zinc-700" strokeWidth={1.25} />
            <p className="font-medium text-zinc-500">No project loaded</p>
            <p className="mt-2">
              Create a new timeline (<span className="font-mono text-zinc-500">{mod}+N</span>) or open a{" "}
              <span className="text-zinc-500">.cut</span> file from the toolbar, then import media here.
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-zinc-800/90 bg-zinc-950/40 px-3 py-6 text-[11px] leading-relaxed text-zinc-600">
            <Upload className="mx-auto mb-2 h-8 w-8 text-zinc-700" strokeWidth={1.25} />
            <p className="text-center font-medium text-zinc-500">No clip in the pool yet</p>
            <ul className="mt-3 space-y-2 px-1 text-left">
              <li className="flex gap-2">
                <span className="shrink-0 font-mono text-[10px] text-zinc-700">1.</span>
                <span>
                  <strong className="font-semibold text-zinc-500">Import</strong> adds one full-length clip on an{" "}
                  <strong className="font-semibold text-zinc-500">empty</strong> video track, then asks the engine for a{" "}
                  <span className="text-zinc-500">preview proxy</span> (faster scrub when FFmpeg succeeds).
                </span>
              </li>
              <li className="flex gap-2">
                <span className="shrink-0 font-mono text-[10px] text-zinc-700">2.</span>
                <span>
                  <strong className="font-semibold text-zinc-500">Transcript</strong> — pick a Whisper model in that view,
                  then use <strong className="font-semibold text-zinc-500">Transcribe…</strong> here to send this file over;
                  word-level cuts replace the single clip timeline.
                </span>
              </li>
            </ul>
            <p className="mt-3 text-center text-[10px] text-zinc-700">
              Timeline already has clips? Start a new project or use Transcript for word-level editing.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
