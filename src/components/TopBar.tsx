import type { ReactNode } from "react";
import {
  Activity,
  AlertCircle,
  Clapperboard,
  Hash,
  LayoutGrid,
  ScrollText,
  Sparkles,
} from "lucide-react";

import type { EngineInfo, HeadResult } from "../lib/engineClient";
import { cn } from "../lib/cn";
import { modKeySymbol } from "../lib/modKey";
import { Kbd } from "./ui/Kbd";

export type ViewMode = "timeline" | "transcript";

interface Props {
  info: EngineInfo | null;
  head: HeadResult | null;
  /** Last engine error to surface in-line, e.g. "engine spawn failed". */
  error: string | null;
  onOpenPalette: () => void;
  view: ViewMode;
  onChangeView: (next: ViewMode) => void;
}

/**
 * App chrome: brand + project · view tabs | centered command entry | engine status.
 */
export function TopBar({ info, head, error, onOpenPalette, view, onChangeView }: Props) {
  const mod = modKeySymbol();

  return (
    <header className="grid h-11 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-b border-zinc-800/80 bg-[var(--cut-bg-deep)] px-3">
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
        <div
          role="tablist"
          className="ml-1 flex shrink-0 items-center rounded-lg border border-zinc-800/90 bg-zinc-950 p-0.5"
        >
          <ViewTab
            label="Timeline"
            icon={<LayoutGrid className="h-3.5 w-3.5" strokeWidth={2} />}
            active={view === "timeline"}
            onClick={() => onChangeView("timeline")}
          />
          <ViewTab
            label="Transcript"
            icon={<ScrollText className="h-3.5 w-3.5" strokeWidth={2} />}
            active={view === "transcript"}
            onClick={() => onChangeView("transcript")}
          />
        </div>
      </div>

      {/* Center: palette */}
      <div className="flex justify-center px-2">
        <button
          type="button"
          onClick={onOpenPalette}
          className="group flex h-8 w-[min(22rem,calc(100vw-12rem))] items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 text-left text-xs text-zinc-500 shadow-sm transition hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-300"
          aria-label="Open AI command palette"
        >
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-zinc-600 group-hover:text-orange-400/90" strokeWidth={2} />
          <span className="min-w-0 flex-1 truncate">Ask CUT to edit...</span>
          <Kbd className="shrink-0 border-zinc-700 group-hover:border-zinc-600">
            {mod}
            K
          </Kbd>
        </button>
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

interface ViewTabProps {
  label: string;
  icon: ReactNode;
  active: boolean;
  onClick: () => void;
}

function ViewTab({ label, icon, active, onClick }: ViewTabProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
        active ? "bg-zinc-800 text-zinc-100 shadow-sm" : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300",
      )}
    >
      <span className={cn(active ? "text-orange-400/95" : "text-zinc-600")}>{icon}</span>
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
