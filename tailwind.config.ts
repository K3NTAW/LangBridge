import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      colors: {
        // Tokens for the timeline; keep in sync with src/lib/tokens.ts.
        track: {
          bg: "#0a0a0b",
          border: "#1f1f23",
          ruler: "#27272a",
          playhead: "#f97316",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
