/** Modifier glyph for keyboard shortcuts (macOS vs Windows/Linux). */
export function modKeySymbol(): string {
  if (typeof navigator === "undefined") return "⌘";
  const ua = navigator.userAgent ?? "";
  const p = navigator.platform ?? "";
  return /Mac|iPhone|iPad|iPod/i.test(p) || /\bMac OS\b/i.test(ua) ? "⌘" : "Ctrl";
}
