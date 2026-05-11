import { useCallback, useEffect, useMemo, useState } from "react";
import { TimelinePane } from "./components/TimelinePane";
import { PreviewPane } from "./components/PreviewPane";
import { MediaPoolPane } from "./components/MediaPoolPane";
import { TopBar, type ViewMode } from "./components/TopBar";
import { CommandPalette } from "./components/CommandPalette";
import { TranscriptEditorPane } from "./components/TranscriptEditorPane";
import { EngineToolbar } from "./components/EngineToolbar";
import { getEngineClient, type TimelineLayoutResult } from "./lib/engineClient";
import { secondsToTicksApprox, ticksToSecondsF64, type Tick } from "./lib/time";
import { useTimelineTransport } from "./lib/useTimelineTransport";
import { useEngineProject } from "./lib/useEngineProject";
import { loadStoredWhisperModel, saveStoredWhisperModel } from "./lib/whisperModels";

export default function App() {
  const project = useEngineProject();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [view, setView] = useState<ViewMode>("timeline");
  const [playheadTicks, setPlayheadTicks] = useState<Tick>(0n);
  const [timelineDurationSeconds, setTimelineDurationSeconds] = useState<number | null>(null);
  const [timelineLayout, setTimelineLayout] = useState<TimelineLayoutResult | null>(null);
  const [bootstrapTranscribePath, setBootstrapTranscribePath] = useState<string | null>(null);
  const [whisperModel, setWhisperModel] = useState(loadStoredWhisperModel);

  const onWhisperModelChange = useCallback((modelId: string) => {
    setWhisperModel(modelId);
    saveStoredWhisperModel(modelId);
  }, []);

  useEffect(() => {
    if (!project.head) {
      setTimelineLayout(null);
      return;
    }
    let cancelled = false;
    void getEngineClient()
      .timelineLayout()
      .then((r) => {
        if (!cancelled) setTimelineLayout(r);
      })
      .catch(() => {
        if (!cancelled) setTimelineLayout(null);
      });
    return () => {
      cancelled = true;
    };
  }, [project.head?.project_id, project.head?.head, project.head?.n_ops]);

  /** Sequence extent when clips exist (caps scrub + transport to edit length). */
  const timelineEditExtentSeconds = useMemo(() => {
    if (!timelineLayout || timelineLayout.clips.length === 0) return null;
    const ticks = timelineLayout.timeline_duration_ticks;
    if (!Number.isFinite(ticks) || ticks <= 0) return null;
    const sec = ticksToSecondsF64(BigInt(ticks));
    return Number.isFinite(sec) && sec > 0 ? sec : null;
  }, [timelineLayout]);

  const playbackExtentSeconds = useMemo(() => {
    if (timelineEditExtentSeconds !== null && timelineEditExtentSeconds > 0) {
      return timelineEditExtentSeconds;
    }
    if (timelineDurationSeconds !== null && timelineDurationSeconds > 0) {
      return timelineDurationSeconds;
    }
    return null;
  }, [timelineEditExtentSeconds, timelineDurationSeconds]);

  const { playing, setPlaying, togglePlaying } = useTimelineTransport({
    durationSeconds: playbackExtentSeconds,
    playheadTicks,
    setPlayheadTicks,
  });

  const scrubPlayhead = useCallback((t: Tick) => {
    setPlaying(false);
    setPlayheadTicks(t);
  }, [setPlaying, setPlayheadTicks]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;

      if (!mod && view === "timeline" && e.code === "Space") {
        const el = e.target as HTMLElement | null;
        if (el?.closest("input, textarea, [contenteditable='true']")) return;
        e.preventDefault();
        togglePlaying();
        return;
      }

      if (mod && e.key === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (e.key === "Escape") {
        setPaletteOpen(false);
        return;
      }
      if (!mod) return;
      switch (e.key.toLowerCase()) {
        case "n":
          e.preventDefault();
          void project.newProject();
          break;
        case "o":
          e.preventDefault();
          void project.openProject();
          break;
        case "s":
          e.preventDefault();
          if (e.shiftKey) {
            void project.saveProjectAs();
          } else {
            void project.saveProject();
          }
          break;
        case "z":
          // Cmd-Z = undo, Cmd-Shift-Z = redo (the macOS convention).
          // We also accept Cmd-Y as an alias for redo for muscle
          // memory from other platforms.
          e.preventDefault();
          if (e.shiftKey) {
            void project.redo();
          } else {
            void project.undo();
          }
          break;
        case "y":
          e.preventDefault();
          void project.redo();
          break;
        default:
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [project, view, togglePlaying]);

  useEffect(() => {
    if (view !== "timeline") setPlaying(false);
  }, [view, setPlaying]);

  useEffect(() => {
    setPlayheadTicks(0n);
    setPlaying(false);
  }, [project.head?.project_id, setPlaying]);

  useEffect(() => {
    if (playbackExtentSeconds === null || playbackExtentSeconds <= 0) return;
    const maxT = secondsToTicksApprox(playbackExtentSeconds);
    setPlayheadTicks((t) => (t > maxT ? maxT : t));
  }, [playbackExtentSeconds]);

  return (
    <div className="flex h-full flex-col bg-[var(--cut-bg-deep)] text-zinc-100">
      <TopBar
        info={project.info}
        head={project.head}
        error={project.error}
        onOpenPalette={() => setPaletteOpen(true)}
        view={view}
        onChangeView={setView}
      />
      <EngineToolbar project={project} />

      <main className="flex flex-1 overflow-hidden">
        {view === "transcript" ? (
          <section className="flex flex-1 flex-col">
            <TranscriptEditorPane
              project={project}
              bootstrapMediaPath={bootstrapTranscribePath}
              onBootstrapConsumed={() => setBootstrapTranscribePath(null)}
              whisperModel={whisperModel}
              onWhisperModelChange={onWhisperModelChange}
            />
          </section>
        ) : (
          <>
            <aside className="w-72 shrink-0 border-r border-zinc-800/80 bg-[var(--cut-bg-deep)]">
              <MediaPoolPane
                project={project}
                whisperModelSelected={Boolean(whisperModel.trim())}
                onRequestTranscribe={(mediaPath) => {
                  setBootstrapTranscribePath(mediaPath);
                  setView("transcript");
                }}
              />
            </aside>
            <section className="flex flex-1 flex-col">
              <div className="flex flex-1 items-center justify-center bg-black">
                <PreviewPane
                  project={project}
                  playheadTicks={playheadTicks}
                  onPlayheadTicksChange={scrubPlayhead}
                  onTimelineDurationSecondsChange={setTimelineDurationSeconds}
                  timelineEditExtentSeconds={timelineEditExtentSeconds}
                  playing={playing}
                />
              </div>
              <div className="h-80 shrink-0 border-t border-zinc-800/80 bg-[var(--cut-bg-deep)]">
                <TimelinePane
                  playheadTicks={playheadTicks}
                  onPlayheadTicksChange={scrubPlayhead}
                  playbackExtentSeconds={playbackExtentSeconds}
                  clips={timelineLayout?.clips ?? []}
                  timelineDurationTicks={timelineLayout?.timeline_duration_ticks ?? 0}
                  playing={playing}
                  onTogglePlay={togglePlaying}
                />
              </div>
            </section>
          </>
        )}
      </main>

      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}
