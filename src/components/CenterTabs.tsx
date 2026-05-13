/**
 * CenterTabs — Player / Transcript toggle for the center pane.
 *
 * Uses the design-system .tab-strip / .tab classes from index.css. The
 * `right` slot holds status + action buttons (rendered upstream in App.tsx).
 */
import { LayoutGrid, ScrollText } from "lucide-react";
import type { ReactNode } from "react";

export type CenterTab = "player" | "transcript";

interface Props {
  active: CenterTab;
  onChange: (next: CenterTab) => void;
  right?: ReactNode;
}

const TABS: { id: CenterTab; label: string; icon: ReactNode; hint: string }[] = [
  {
    id: "player",
    label: "Player",
    icon: <LayoutGrid size={12} strokeWidth={2} />,
    hint: "⌘1",
  },
  {
    id: "transcript",
    label: "Transcript",
    icon: <ScrollText size={12} strokeWidth={2} />,
    hint: "⌘2",
  },
];

export function CenterTabs({ active, onChange, right }: Props) {
  return (
    <div className="tab-strip">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          onClick={() => onChange(t.id)}
          title={t.hint}
          className={`tab ${active === t.id ? "is-active" : ""}`}
        >
          {t.icon}
          {t.label}
          <span className="kbd">{t.hint}</span>
        </button>
      ))}
      <div className="spacer" />
      <div className="action-row">{right}</div>
    </div>
  );
}
