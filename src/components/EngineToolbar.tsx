/**
 * Engine toolbar — project file ops + canary sequence create.
 */
import type { ReactNode } from "react";
import { Film, FolderOpen, Layers, Plus, Save, SaveAll } from "lucide-react";
import { useCallback } from "react";

import type { Op, SequenceId } from "../lib/ops";
import { asId } from "../lib/ops";
import type { Rate } from "../lib/time";
import { ulidLite } from "../lib/ulid";
import type { UseEngineProject } from "../lib/useEngineProject";
import { cn } from "../lib/cn";
import { modKeySymbol } from "../lib/modKey";

interface Props {
  project: UseEngineProject;
}

export function EngineToolbar({ project }: Props) {
  const { newProject, openProject, saveProject, saveProjectAs, apply, head, busy } = project;
  const mod = modKeySymbol();

  const onApplySequence = useCallback(async () => {
    const op = makeSequenceCreate();
    await apply(op);
  }, [apply]);

  const hasProject = head !== null;

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-zinc-800/70 bg-[var(--cut-bg-panel)] px-2">
      <ToolbarIconButton onClick={newProject} disabled={busy} title={`New project (${mod}+N)`} label="New">
        <Plus className="h-3.5 w-3.5" strokeWidth={2} />
      </ToolbarIconButton>
      <ToolbarIconButton onClick={openProject} disabled={busy} title={`Open project (${mod}+O)`} label="Open">
        <FolderOpen className="h-3.5 w-3.5" strokeWidth={2} />
      </ToolbarIconButton>
      <ToolbarIconButton onClick={saveProject} disabled={busy || !hasProject} title={`Save (${mod}+S)`} label="Save">
        <Save className="h-3.5 w-3.5" strokeWidth={2} />
      </ToolbarIconButton>
      <ToolbarIconButton
        onClick={saveProjectAs}
        disabled={busy || !hasProject}
        title={`Save As (${mod}+⇧+S)`}
        label="Save As"
      >
        <SaveAll className="h-3.5 w-3.5" strokeWidth={2} />
      </ToolbarIconButton>

      <span className="mx-1.5 h-5 w-px shrink-0 bg-zinc-800" aria-hidden />

      <ToolbarIconButton
        onClick={onApplySequence}
        disabled={busy || !hasProject}
        title="Apply a SequenceCreate op (demo)"
        label="Sequence"
        accent
      >
        <Layers className="h-3.5 w-3.5" strokeWidth={2} />
      </ToolbarIconButton>
      <span className="ml-auto hidden items-center gap-1 text-[10px] uppercase tracking-wide text-zinc-600 sm:flex">
        <Film className="h-3 w-3 opacity-70" strokeWidth={2} />
        Engine
      </span>
    </div>
  );
}

function ToolbarIconButton({
  onClick,
  disabled,
  title,
  label,
  accent,
  children,
}: {
  onClick: () => void | Promise<void>;
  disabled?: boolean;
  title?: string;
  label: string;
  accent?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title ?? label}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        accent
          ? "border-orange-500/35 bg-orange-500/10 text-orange-200 hover:border-orange-500/55 hover:bg-orange-500/18"
          : "border-transparent bg-transparent text-zinc-400 hover:border-zinc-800 hover:bg-zinc-900 hover:text-zinc-200",
      )}
      onClick={() => {
        void onClick();
      }}
      disabled={disabled}
    >
      {children}
      <span className="hidden lg:inline">{label}</span>
    </button>
  );
}

function makeSequenceCreate(): Op {
  const id = ulidLite();
  const rate: Rate = { num: 24, den: 1 };
  return {
    kind: "sequence_create",
    sequence_id: asId<"SequenceId">(id) as SequenceId,
    name: "Sequence (toolbar)",
    frame_rate: rate,
    sample_rate: 48_000,
  };
}
