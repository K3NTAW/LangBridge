import type { ReactNode } from "react";

import { cn } from "../../lib/cn";

interface KbdProps {
  children: ReactNode;
  className?: string;
}

/** Inline keyboard key styling for shortcuts. */
export function Kbd({ children, className }: KbdProps) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center rounded border border-zinc-600 bg-zinc-900 px-1 py-px font-mono text-[10px] font-medium tabular-nums text-zinc-400",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
