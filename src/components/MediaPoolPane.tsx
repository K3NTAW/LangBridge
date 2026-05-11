/**
 * Media pool pane (left sidebar).
 *
 * **Today:** import a video file into the engine as one full-length clip
 * on the primary video track (empty timeline only). Media list UI comes later.
 */
import { AlertTriangle, HardDrive, Loader2, Mic, Upload } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useState } from "react";

import { cn } from "../lib/cn";
import { modKeySymbol } from "../lib/modKey";
import { importMediaFullClip } from "../lib/simpleMediaImport";
import type { UseEngineProject } from "../lib/useEngineProject";

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

  const onImport = useCallback(async () => {
    if (!project.head) return;
    setLocalError(null);
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
    setBusy(true);
    setImportPhase("batch");
    try {
      const r = await importMediaFullClip(picked, (ops) => project.applyBatch(ops), {
        onAfterBatch: () => setImportPhase("proxy"),
        proxyGenerate: async (sourceId) => {
          await project.proxyGenerate(sourceId as unknown as string);
        },
      });
      if (!r.ok) {
        setLocalError(r.message);
        return;
      }
      setLastPath(picked);
    } finally {
      setImportPhase("idle");
      setBusy(false);
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
          <div className="flex gap-2 rounded-md border border-amber-900/45 bg-amber-950/25 px-2.5 py-2 text-[11px] text-amber-100/95">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" strokeWidth={2} />
            <span>{localError}</span>
          </div>
        ) : null}
        {busy && importPhase !== "idle" ? (
          <div className="flex items-center gap-2 rounded-md border border-zinc-700/60 bg-zinc-900/55 px-2.5 py-2 text-[11px] text-zinc-400">
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-zinc-500" strokeWidth={2} />
            {importPhase === "batch" ? "Importing timeline..." : "Generating preview proxy..."}
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
        ) : (
          <div className="rounded-lg border border-dashed border-zinc-800/90 bg-zinc-950/40 px-3 py-6 text-center text-[11px] leading-relaxed text-zinc-600">
            <Upload className="mx-auto mb-2 h-8 w-8 text-zinc-700" strokeWidth={1.25} />
            <p className="text-zinc-500">Import one full-length clip on an empty video track.</p>
            <p className="mt-2 text-zinc-600">
              New project ({mod}+N), then Import.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
