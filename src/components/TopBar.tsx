/**
 * Sift TopBar — design system v0.1.
 *
 * Wordmark (copper tile + "sift") · folder breadcrumb pill · engine + sift-ai
 * health dots. Pure CSS classes from index.css — no Tailwind utilities here.
 */
import { ChevronDown, Folder, FolderOpen, Settings } from "lucide-react";

import type { EngineInfo, HeadResult } from "../lib/engineClient";
import type { SiftAiHealth } from "../lib/siftAiHealth";
import type { FolderProject } from "../lib/folderProject";

interface Props {
  info: EngineInfo | null;
  head: HeadResult | null;
  error: string | null;
  folder: FolderProject | null;
  aiHealth: SiftAiHealth;
}

export function TopBar({ info, head, error, folder, aiHealth }: Props) {
  return (
    <div className="topbar">
      <Wordmark />

      {folder ? <FolderPill folder={folder} /> : <NoFolderPill />}

      <div className="spacer" />

      {error ? <ErrorChip text={error} /> : null}

      <div className="health">
        <HealthItem
          label="engine"
          tone={head !== null ? "ok" : info !== null ? "info" : "danger"}
          tooltip={
            info
              ? `engine — ${head !== null ? "ok" : "starting"} · v${info.engine_version}`
              : "engine — starting"
          }
        />
        <HealthItem
          label="sift-ai"
          tone={aiHealth === "ok" ? "ok" : aiHealth === "down" ? "danger" : "warn"}
          tooltip={
            aiHealth === "ok"
              ? "sift-ai — reachable"
              : aiHealth === "down"
                ? "sift-ai — not reachable"
                : "sift-ai — probing…"
          }
        />
      </div>

      <button className="icon-btn" title="Settings" aria-label="Settings">
        <Settings size={14} strokeWidth={2} />
      </button>
    </div>
  );
}

function Wordmark() {
  return (
    <div className="wordmark">
      <div className="mark" aria-hidden />
      <span className="name">sift</span>
    </div>
  );
}

function NoFolderPill() {
  return (
    <div className="folder-pill" style={{ color: "var(--fg-subtle)" }}>
      <Folder size={12} strokeWidth={2} />
      <span>No folder open</span>
    </div>
  );
}

function FolderPill({ folder }: { folder: FolderProject }) {
  const { parent, leaf } = splitPath(folder.folderPath);
  return (
    <div className="folder-pill" title={folder.folderPath}>
      <FolderOpen size={12} strokeWidth={2} />
      {parent ? <span className="path">{parent}/</span> : null}
      <span className="leaf">{leaf}</span>
      <ChevronDown size={12} strokeWidth={2} style={{ marginLeft: 4, opacity: 0.6 }} />
    </div>
  );
}

function ErrorChip({ text }: { text: string }) {
  return (
    <span className="badge is-danger" title={text}>
      {truncate(text, 28)}
    </span>
  );
}

type HealthTone = "ok" | "warn" | "danger" | "info";

function HealthItem({
  label,
  tone,
  tooltip,
}: {
  label: string;
  tone: HealthTone;
  tooltip: string;
}) {
  const cls =
    tone === "ok"
      ? ""
      : tone === "warn"
        ? "is-warn"
        : tone === "danger"
          ? "is-danger"
          : "is-info";
  return (
    <div className={`health-item ${cls}`} title={tooltip}>
      <span className="dot" />
      <span className="label t-mono" style={{ fontSize: 10.5 }}>
        {label}
      </span>
    </div>
  );
}

function splitPath(p: string): { parent: string; leaf: string } {
  const parts = p.split(/[/\\]+/).filter((s) => s.length > 0);
  if (parts.length === 0) return { parent: "", leaf: p };
  const leaf = parts[parts.length - 1] ?? "";
  // Keep up to 3 parent segments so the pill stays compact.
  const trimmed = parts.slice(Math.max(0, parts.length - 4), -1);
  return { parent: trimmed.join("/"), leaf };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
