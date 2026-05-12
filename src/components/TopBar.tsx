import { Activity, AlertCircle, Clapperboard, Hash } from "lucide-react";

import type { EngineInfo, HeadResult } from "../lib/engineClient";

interface Props {
  info: EngineInfo | null;
  head: HeadResult | null;
  /** Last engine error to surface in-line, e.g. "engine spawn failed". */
  error: string | null;
}

/**
 * App chrome for Sift: brand + project · engine status. The Timeline /
 * Transcript view tabs are gone (single-view layout) and the Cmd-K
 * palette button is gone (chat lives inline in the center pane).
 */
export function TopBar({ info, head, error }: Props) {
  return (
    <header className="grid h-11 shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 border-b border-zinc-800/80 bg-[var(--cut-bg-deep)] px-3">
      {/* Left cluster */}
      <div className="flex min-w-0 items-center gap-2">
        <div
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--cut-accent-muted)] text-[var(--cut-accent)] ring-1 ring-orange-500/25"
          aria-hidden
        >
          <Clapperboard className="h-4 w-4" strokeWidth={2} />
        </div>
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-xs font-medium text-zinc-200">{projectLabel(head)}</span>
          <span className="truncate text-[10px] text-zinc-500">
            {head ? `${head.n_ops} edit${head.n_ops === 1 ? "" : "s"}` : "No project"}
          </span>
        </div>
      </div>

      {/* Right cluster */}
      <div className="flex min-w-0 items-center justify-end gap-2 text-xs">
        {error ? (
          <span
            className="inline-flex max-w-[min(14rem,28vw)] items-center gap-1 truncate rounded-md bg-red-950/55 px-2 py-1 text-red-300 ring-1 ring-red-900/50"
            title={error}
          >
            <AlertCircle className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
            <span className="truncate">{truncate(error, 48)}</span>
          </span>
        ) : null}
        {head?.head ? (
          <span
            className="hidden items-center gap-1 rounded-md bg-zinc-900 px-2 py-1 text-zinc-400 ring-1 ring-zinc-800 sm:inline-flex"
            title={`Head op-id: ${head.head}`}
          >
            <Hash className="h-3 w-3 text-zinc-600" strokeWidth={2} />
            <span className="font-mono text-[11px] tabular-nums text-zinc-300">{head.head.slice(0, 8)}</span>
          </span>
        ) : null}
        <span className="inline-flex items-center gap-1.5 truncate text-[11px] tabular-nums text-zinc-500">
          <Activity className="h-3.5 w-3.5 shrink-0 text-zinc-600" strokeWidth={2} />
          <span className="truncate">
            {info ? (
              <>
                v{info.engine_version}
                <span className="text-zinc-700"> · </span>
                spec {info.spec_version}
              </>
            ) : (
              "Connecting..."
            )}
          </span>
        </span>
      </div>
    </header>
  );
}

function projectLabel(head: HeadResult | null): string {
  if (!head) return "Untitled project";
  return `Project ${head.project_id.slice(0, 8)}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}...` : s;
}
