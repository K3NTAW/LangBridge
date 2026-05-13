import type { Config } from "tailwindcss";

/**
 * Sift design system v0.1 (see docs/sift-design.pdf).
 *
 * Tokens are defined as CSS variables in `src/index.css` and exposed
 * here so Tailwind utilities pick them up. The `colors.sift.*` namespace
 * mirrors the design token names exactly.
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        // SF Pro Display drives headlines; SF Pro Text the rest of the UI.
        // The macOS system stack covers both transparently.
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "SF Pro Text",
          "SF Pro Display",
          "Inter",
          "system-ui",
          "sans-serif",
        ],
        display: [
          "-apple-system",
          "BlinkMacSystemFont",
          "SF Pro Display",
          "Inter",
          "system-ui",
          "sans-serif",
        ],
        mono: [
          "SF Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      fontSize: {
        display: ["28px", { lineHeight: "1.15", letterSpacing: "-0.022em", fontWeight: "600" }],
        title: ["17px", { lineHeight: "1.3", fontWeight: "600" }],
        subtitle: ["14px", { lineHeight: "1.4", fontWeight: "500" }],
        body: ["13px", { lineHeight: "1.5", fontWeight: "400" }],
        small: ["12px", { lineHeight: "1.4", fontWeight: "400" }],
        micro: ["10.5px", { lineHeight: "1.2", fontWeight: "600", letterSpacing: "0.06em" }],
      },
      colors: {
        sift: {
          // Surfaces
          "bg-base": "var(--sift-bg-base)",
          "bg-elevated": "var(--sift-bg-elevated)",
          "bg-sunken": "var(--sift-bg-sunken)",
          "bg-hover": "var(--sift-bg-hover)",
          "bg-active": "var(--sift-bg-active)",
          // Foreground
          fg: "var(--sift-fg)",
          "fg-muted": "var(--sift-fg-muted)",
          "fg-subtle": "var(--sift-fg-subtle)",
          "fg-faint": "var(--sift-fg-faint)",
          // Accents
          primary: "var(--sift-accent-primary)",
          "primary-hover": "var(--sift-accent-primary-hover)",
          "primary-pressed": "var(--sift-accent-primary-pressed)",
          success: "var(--sift-accent-success)",
          warn: "var(--sift-accent-warn)",
          danger: "var(--sift-accent-danger)",
          info: "var(--sift-accent-info)",
          // Borders
          "border-default": "var(--sift-border-default)",
          "border-strong": "var(--sift-border-strong)",
          "border-focus": "var(--sift-border-focus)",
        },
        // Legacy aliases used by surviving components. Resolve to the new tokens
        // so we can port surface-by-surface without breaking everything at once.
        track: {
          bg: "var(--sift-bg-base)",
          border: "var(--sift-border-default)",
          ruler: "var(--sift-border-strong)",
          playhead: "var(--sift-accent-primary)",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
