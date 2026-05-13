/**
 * First-run welcome overlay — design system v0.1.
 *
 * Centered modal with the copper hero mark, the three pillars from the
 * pivot plan, and two CTAs.
 */
import { Film, Folder, Sparkles } from "lucide-react";

interface Props {
  onDismiss: () => void;
}

export function FirstRunOverlay({ onDismiss }: Props) {
  return (
    <div
      className="scrim"
      role="dialog"
      aria-modal
      aria-labelledby="sift-welcome-title"
    >
      <div className="modal welcome">
        <div className="welcome-body">
          <div className="hero-mark" aria-hidden />
          <h1 id="sift-welcome-title">Welcome to Sift</h1>
          <p className="lead">
            Open a folder of footage. Tell Sift what you want. Watch the cut, approve or
            undo, export.
          </p>
          <ul>
            <li>
              <span className="pillar-icon">
                <Folder size={12} strokeWidth={2.25} />
              </span>
              <div>
                <div className="pillar-title">Local-first.</div>
                <div className="pillar-sub">
                  Footage never leaves your machine. Chat is opt-in per project.
                </div>
              </div>
            </li>
            <li>
              <span className="pillar-icon">
                <Sparkles size={12} strokeWidth={2.25} />
              </span>
              <div>
                <div className="pillar-title">Conversational, not one-shot.</div>
                <div className="pillar-sub">
                  Iterate with the assistant. Approve or undo each proposal.
                </div>
              </div>
            </li>
            <li>
              <span className="pillar-icon">
                <Film size={12} strokeWidth={2.25} />
              </span>
              <div>
                <div className="pillar-title">Built for long-form.</div>
                <div className="pillar-sub">
                  Podcasts, interviews, lectures — 30 minutes to 3 hours.
                </div>
              </div>
            </li>
          </ul>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn is-primary" onClick={onDismiss}>
              Get started
            </button>
            <button
              type="button"
              className="btn is-tertiary"
              onClick={onDismiss}
              title="Coming soon"
            >
              Open recent
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
