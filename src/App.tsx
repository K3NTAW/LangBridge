/**
 * Sift — chat-first, folder-as-project AI video editor.
 *
 * Layout: folder pane (left) | transcript + chat (center) | preview (right).
 *
 * For Milestone A the chat panel is a placeholder; the user drives edits
 * via the transcript pane's existing word-delete and auto-clean affordances.
 * Milestone B replaces the placeholder with Claude tool-use chat.
 */
import { useCallback, useEffect, useState } from "react";

import { MediaPoolPane } from "./components/MediaPoolPane";
import { PreviewPane } from "./components/PreviewPane";
import { TopBar } from "./components/TopBar";
import { TranscriptEditorPane } from "./components/TranscriptEditorPane";
import { EngineToolbar } from "./components/EngineToolbar";
import { FirstRunOverlay } from "./components/FirstRunOverlay";
import { dismissOnboardingPersist, readOnboardingDismissed } from "./lib/onboardingStorage";
import { useEngineProject } from "./lib/useEngineProject";
import { loadStoredWhisperModel, saveStoredWhisperModel } from "./lib/whisperModels";

export default function App() {
  const project = useEngineProject();
  const [bootstrapTranscribePath, setBootstrapTranscribePath] = useState<string | null>(null);
  const [whisperModel, setWhisperModel] = useState(loadStoredWhisperModel);
  const [onboardingOpen, setOnboardingOpen] = useState(() => !readOnboardingDismissed());

  // Preview file produced by the segment-cache renderer. Null until
  // Milestone A wires `lib/previewRender.ts` in.
  const [previewPath] = useState<string | null>(null);
  const [previewRendering] = useState<boolean>(false);

  const dismissOnboarding = useCallback(() => {
    dismissOnboardingPersist();
    setOnboardingOpen(false);
  }, []);

  const onWhisperModelChange = useCallback((modelId: string) => {
    setWhisperModel(modelId);
    saveStoredWhisperModel(modelId);
  }, []);

  // Keyboard shortcuts: project lifecycle + undo/redo.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
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
  }, [project]);

  return (
    <div className="flex h-full flex-col bg-[var(--cut-bg-deep)] text-zinc-100">
      <TopBar
        info={project.info}
        head={project.head}
        error={project.error}
      />
      <EngineToolbar project={project} />

      <main className="grid flex-1 grid-cols-[18rem_minmax(0,1fr)_28rem] overflow-hidden">
        {/* Left: folder / media pane */}
        <aside className="min-w-0 border-r border-zinc-800/80 bg-[var(--cut-bg-deep)]">
          <MediaPoolPane
            project={project}
            whisperModelSelected={Boolean(whisperModel.trim())}
            onRequestTranscribe={(mediaPath) => setBootstrapTranscribePath(mediaPath)}
          />
        </aside>

        {/* Center: transcript editor (will gain a chat panel underneath in Milestone B) */}
        <section className="flex min-w-0 flex-col overflow-hidden">
          <TranscriptEditorPane
            project={project}
            bootstrapMediaPath={bootstrapTranscribePath}
            onBootstrapConsumed={() => setBootstrapTranscribePath(null)}
            whisperModel={whisperModel}
            onWhisperModelChange={onWhisperModelChange}
          />
        </section>

        {/* Right: preview */}
        <section className="min-w-0 border-l border-zinc-800/80 bg-black">
          <PreviewPane previewPath={previewPath} rendering={previewRendering} />
        </section>
      </main>

      {onboardingOpen ? <FirstRunOverlay onDismiss={dismissOnboarding} /> : null}
    </div>
  );
}
