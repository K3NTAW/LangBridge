/**
 * FolderPane — left column of the Sift workspace.
 *
 * Renders using design-system CSS classes from index.css. Functional
 * behaviour (open / scan / refresh, active row, per-video transcription
 * status badge) is preserved.
 */
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  Clock,
  Film,
  Folder,
  FolderOpen,
  Loader2,
  RefreshCw,
  Video,
  X,
} from "lucide-react";
import { useCallback, useState } from "react";

import {
  openFolderProject,
  refreshFolderVideos,
  type FolderProject,
  type FolderVideo,
} from "../lib/folderProject";
import type { TranscriptionEntry } from "../lib/transcriptionQueue";
import type { SiftAiHealth } from "../lib/siftAiHealth";
import { modKeySymbol } from "../lib/modKey";

interface Props {
  folder: FolderProject | null;
  onFolderChange: (folder: FolderProject | null) => void;
  activeVideoPath: string | null;
  onActiveVideoChange: (path: string | null) => void;
  transcriptionStatus?: ReadonlyMap<string, TranscriptionEntry>;
  aiHealth?: SiftAiHealth;
  /** Called when the user clicks the collapse chevron in the panel header. */
  onCollapse?: () => void;
}

function formatBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function folderBasename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i === -1 ? p : p.slice(i + 1);
}

export function FolderPane({
  folder,
  onFolderChange,
  activeVideoPath,
  onActiveVideoChange,
  transcriptionStatus,
  aiHealth = "unknown",
  onCollapse,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onOpen = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const next = await openFolderProject();
      if (next) {
        onFolderChange(next);
        onActiveVideoChange(next.videos[0]?.path ?? null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [onFolderChange, onActiveVideoChange]);

  const onRefresh = useCallback(async () => {
    if (!folder) return;
    setError(null);
    setRefreshing(true);
    try {
      const videos = await refreshFolderVideos(folder);
      onFolderChange({ ...folder, videos });
      if (activeVideoPath && !videos.some((v) => v.path === activeVideoPath)) {
        onActiveVideoChange(videos[0]?.path ?? null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, [folder, activeVideoPath, onFolderChange, onActiveVideoChange]);

  return (
    <div className="panel folder-pane">
      <div className="panel-header">
        <div className="panel-title">Folder</div>
        <div className="spacer" />
        {onCollapse ? (
          <>
            <span className="kbd-hint" title="Toggle folder pane">
              {modKeySymbol()}B
            </span>
            <button
              type="button"
              className="btn-collapse"
              onClick={onCollapse}
              title={`Collapse folder pane (${modKeySymbol()}B)`}
              aria-label="Collapse folder pane"
            >
              <ChevronLeft size={13} strokeWidth={2} />
            </button>
          </>
        ) : null}
        {folder ? (
          <button
            type="button"
            className="btn is-tertiary is-xs"
            onClick={() => void onRefresh()}
            disabled={refreshing}
            title="Re-scan the folder for new videos"
          >
            <RefreshCw size={11} strokeWidth={2} className={refreshing ? "spin" : ""} />
            Refresh
          </button>
        ) : (
          <button
            type="button"
            className="btn is-secondary is-xs"
            onClick={() => void onOpen()}
            disabled={busy}
          >
            {busy ? (
              <Loader2 size={11} strokeWidth={2} className="spin" />
            ) : (
              <Folder size={11} strokeWidth={2} />
            )}
            Open…
          </button>
        )}
      </div>

      {folder ? <FolderSummary folder={folder} /> : null}

      {aiHealth === "down" ? <SiftAiDownBanner /> : null}

      {error ? (
        <div className="banner is-warn" role="alert">
          <AlertTriangle className="b-icon" size={14} strokeWidth={2} />
          <div className="b-body">
            <div className="b-title">Could not open folder</div>
            <div className="b-sub">{error}</div>
          </div>
          <button className="b-close" onClick={() => setError(null)} aria-label="Dismiss">
            <X size={12} strokeWidth={2} />
          </button>
        </div>
      ) : null}

      <div className="video-list">
        {folder ? (
          folder.videos.length > 0 ? (
            <>
              <div className="list-section-label">
                <span>Videos</span>
                <span className="count">{folder.videos.length}</span>
              </div>
              {folder.videos.map((v) => (
                <VideoRow
                  key={v.path}
                  video={v}
                  active={v.path === activeVideoPath}
                  status={transcriptionStatus?.get(v.path)}
                  onClick={() => onActiveVideoChange(v.path)}
                />
              ))}
            </>
          ) : (
            <EmptyFolder />
          )
        ) : (
          <EmptyState onOpen={() => void onOpen()} busy={busy} />
        )}
      </div>
    </div>
  );
}

function FolderSummary({ folder }: { folder: FolderProject }) {
  const name = folderBasename(folder.folderPath);
  return (
    <div className="summary">
      <div className="summary-row">
        <FolderOpen
          size={14}
          strokeWidth={2}
          style={{ color: "var(--accent-primary)", marginTop: 2, flex: "0 0 auto" }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="folder-name" title={folder.folderPath}>
            {name}
          </div>
          <div className="folder-meta">
            <span>{folder.videos.length} videos</span>
            {folder.resumed ? (
              <>
                <span className="meta-dot" />
                <span
                  className="badge is-success"
                  style={{ height: 16, fontSize: 9.5, padding: "0 5px" }}
                >
                  <Check size={9} strokeWidth={2.5} />
                  resumed
                </span>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function SiftAiDownBanner() {
  return (
    <div className="banner is-danger" role="status" aria-live="polite">
      <AlertTriangle className="b-icon" size={14} strokeWidth={2} />
      <div className="b-body">
        <div className="b-title">sift-ai is not reachable</div>
        <div className="b-sub">Transcription and chat won't work until it's running.</div>
        <pre className="b-code">{`cd sift-ai
.venv/bin/python -m sift_ai`}</pre>
      </div>
    </div>
  );
}

function VideoRow({
  video,
  active,
  status,
  onClick,
}: {
  video: FolderVideo;
  active: boolean;
  status: TranscriptionEntry | undefined;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`video-row ${active ? "is-active" : ""}`}
    >
      <div className="vrow-icon">
        {active ? (
          <Film size={13} strokeWidth={2} />
        ) : (
          <Video size={13} strokeWidth={2} />
        )}
      </div>
      <div className="vrow-body">
        <div className="vrow-name" title={video.path}>
          {video.name}
        </div>
        <div className="vrow-meta">
          <span>{formatBytes(video.sizeBytes)}</span>
        </div>
      </div>
      {status ? <StatusBadge status={status} /> : null}
    </button>
  );
}

function StatusBadge({ status }: { status: TranscriptionEntry }) {
  switch (status.status) {
    case "queued":
      return (
        <span className="badge is-muted">
          <Clock size={10} strokeWidth={2} />
          queued
        </span>
      );
    case "transcribing":
      return (
        <span className="badge is-info">
          <Loader2 size={10} strokeWidth={2} className="spin" />
          transcribing
        </span>
      );
    case "ready":
      return (
        <span
          className="badge is-success"
          title={status.source === "cache" ? "loaded from cache" : "newly transcribed"}
        >
          <Check size={10} strokeWidth={2.5} />
          ready
        </span>
      );
    case "skipped":
      return (
        <span className="badge is-muted" title={status.error ?? ""}>
          <AlertTriangle size={10} strokeWidth={2} />
          skipped
        </span>
      );
    case "failed":
      return (
        <span className="badge is-danger" title={status.error ?? ""}>
          <AlertTriangle size={10} strokeWidth={2} />
          failed
        </span>
      );
  }
}

function EmptyState({ onOpen, busy }: { onOpen: () => void; busy: boolean }) {
  return (
    <div className="empty" style={{ padding: 24 }}>
      <div className="icon-wrap">
        <Folder size={20} strokeWidth={1.75} />
      </div>
      <div className="empty-headline">No folder open</div>
      <div className="empty-sub">
        Open a folder of footage to start. Sift will scan it for videos, transcribe them
        locally, and let you chat your way to a cut.
      </div>
      <button
        type="button"
        className="btn is-primary is-sm"
        onClick={onOpen}
        disabled={busy}
        style={{ marginTop: 16 }}
      >
        {busy ? (
          <Loader2 size={12} strokeWidth={2.5} className="spin" />
        ) : (
          <FolderOpen size={12} strokeWidth={2.5} />
        )}
        Open folder…
      </button>
    </div>
  );
}

function EmptyFolder() {
  return (
    <div className="empty" style={{ padding: 24 }}>
      <div className="icon-wrap">
        <Video size={20} strokeWidth={1.5} />
      </div>
      <div className="empty-headline">No videos found</div>
      <div className="empty-sub">
        Add .mp4 / .mov files to this folder, then click Refresh.
      </div>
    </div>
  );
}
