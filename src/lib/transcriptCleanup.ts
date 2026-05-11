/**
 * Filler-word detection — the magic-moment value prop for the
 * transcript editor.
 *
 * The wedge product (per `REFINED-PLAN.md` §5.3) is "drop a video,
 * get a watchable first cut in 90 seconds." Whisper gives us word
 * timestamps; this module identifies the words that almost certainly
 * shouldn't be in the final cut. The transcript editor applies the
 * detected indices as a `ClipDelete` batch, and the user reviews
 * what's left.
 *
 * ## Design notes
 *
 * Pure functions, no engine or AI dependencies. Lives next to
 * {@link ./transcriptIngest} and follows the same testability rules.
 *
 * **Conservatism is a feature.** A false-positive deletion (the AI
 * removed a word the user said) trains the user to distrust the
 * auto-clean. A false-negative (a filler the AI missed) costs them
 * one click. We bias hard toward false-negatives.
 *
 * That's why the default filler set is short and uncontroversial —
 * sounds, not words. "Like", "actually", "basically", "literally"
 * are excluded: they're frequently meaningful. Multi-token fillers
 * like "you know" and "kind of" are excluded too — phrase detection
 * is a separate problem and the single-token approximation is
 * unreliable.
 *
 * The confidence gate (Whisper's per-word `probability`) catches the
 * other big false-positive class: a low-confidence "uh" that may
 * actually be a real word the model wasn't sure about.
 */

/** Minimum shape of a transcript word for filler detection. */
export interface DetectableWord {
  /** The word string, possibly with leading whitespace and trailing punctuation. */
  word: string;
  /** Whisper's per-word confidence, 0..1. Optional so tests can omit it. */
  probability?: number;
}

/**
 * Default filler set. Lowercase, punctuation-stripped, single-token.
 *
 * These are sounds and interjections that almost never carry semantic
 * meaning in spoken English. Explicitly excluded:
 *
 * - `like` / `actually` / `basically` / `literally` — frequently
 *   meaningful; deleting them rewrites what the speaker said.
 * - `well` / `so` / `right` / `okay` — discourse markers; often
 *   intentional sentence openers.
 * - `you know`, `kind of`, `sort of` — multi-token phrases; the
 *   single-token shape would match the unrelated word `know`.
 */
export const DEFAULT_FILLERS: ReadonlySet<string> = new Set([
  "um",
  "umm",
  "ummm",
  "uh",
  "uhh",
  "uhhh",
  "uhm",
  "uhmm",
  "ah",
  "ahh",
  "er",
  "err",
  "erm",
  "mm",
  "mmm",
  "mhm",
  "hmm",
  "hmmm",
]);

/**
 * Minimum Whisper word probability to auto-delete.
 *
 * Below this threshold, even a word that matches the filler set is
 * left alone — it may be a misheard real word. The cost asymmetry
 * (deleting a real word is much worse than missing a filler) justifies
 * a fairly conservative gate.
 */
export const DEFAULT_MIN_CONFIDENCE = 0.5;

/**
 * Normalize a Whisper word for filler matching.
 *
 * Whisper's `word` strings typically include a leading space (the
 * tokenizer keeps spaces with the following token), and punctuation
 * is attached to the preceding word ("uh," not " , uh"). We strip
 * surrounding non-letter characters and lowercase.
 *
 * Internal characters are preserved — there's no real filler that
 * needs splitting on punctuation. Unicode-aware (`\p{L}`) so we
 * don't accidentally mangle non-ASCII transcripts.
 */
export function normalizeWord(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
}

/** Options controlling {@link detectFillers}. */
export interface DetectFillersOptions {
  /** Override the default filler set (must be lowercase, normalized). */
  fillers?: ReadonlySet<string>;
  /** Override the minimum confidence gate. */
  minConfidence?: number;
}

/**
 * Identify the indices in `words` that are fillers safe to auto-delete.
 *
 * Returns indices in input order — not a `Set` — so callers can
 * iterate deterministically and ship them to the engine in source-time
 * order if needed.
 *
 * Words missing a `probability` field bypass the confidence gate,
 * which keeps tests terse and makes the function safe to call against
 * synthetic data that doesn't include Whisper metadata.
 */
export function detectFillers(
  words: readonly DetectableWord[],
  options: DetectFillersOptions = {},
): number[] {
  const fillers = options.fillers ?? DEFAULT_FILLERS;
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const out: number[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === undefined) continue;
    const norm = normalizeWord(w.word);
    if (norm === "") continue;
    if (!fillers.has(norm)) continue;
    if (w.probability !== undefined && w.probability < minConfidence) continue;
    out.push(i);
  }
  return out;
}
