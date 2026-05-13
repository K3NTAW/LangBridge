/**
 * Stub planner (Milestone A).
 *
 * Parses a user's chat message and, for a small set of known intents,
 * returns a proposal: `Op[]` ready to apply plus a rationale string.
 * For unknown intents, returns a "don't know how" reply.
 *
 * This is the *deterministic* placeholder for Claude tool-use that
 * arrives in Milestone B. The shape of the proposal (rationale + ops +
 * future artifacts) does not change — only the source of the
 * proposal does.
 */
import type { Op } from "./ops";
import {
  buildFillerDeleteOps,
  buildRangeDeleteOps,
  type TranscriptHandle,
  type TranscriptState,
} from "./transcriptOps";

export type StubIntent = "cut_fillers" | "cut_silences" | "cut_range" | "unknown";

/**
 * Parse a single timestamp like `2:23` (mm:ss) or `1:02:30` (h:mm:ss)
 * into seconds. Returns null on malformed input.
 */
export function parseTimestamp(s: string): number | null {
  const parts = s.split(":").map((p) => Number.parseInt(p, 10));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (parts.length === 2) {
    const [m, sec] = parts as [number, number];
    if (sec >= 60) return null;
    return m * 60 + sec;
  }
  if (parts.length === 3) {
    const [h, m, sec] = parts as [number, number, number];
    if (m >= 60 || sec >= 60) return null;
    return h * 3600 + m * 60 + sec;
  }
  return null;
}

// Matches "<start> [to|-|–|—|→|and] <end>" with mm:ss or h:mm:ss
// timestamps. The optional "from"/"between" prefix is consumed by the
// surrounding intent regex; this expression only cares about the two
// timestamps and the joiner.
const TIME_RANGE_RE =
  /(\d{1,2}(?::\d{2}){1,2})\s*(?:to|through|thru|until|–|—|->|→|-|and)\s*(\d{1,2}(?::\d{2}){1,2})/i;

/**
 * Extract a time range from a free-form prompt. Returns null when no
 * pair of timestamps is present (or when the second is not strictly
 * after the first).
 */
export function parseTimeRange(
  input: string,
): { startSecs: number; endSecs: number } | null {
  const m = TIME_RANGE_RE.exec(input);
  if (!m) return null;
  const a = parseTimestamp(m[1]!);
  const b = parseTimestamp(m[2]!);
  if (a === null || b === null) return null;
  if (b <= a) return null;
  return { startSecs: a, endSecs: b };
}

const CUT_VERB_RE = /\b(cut|drop|remove|delete|strip|trim|kill)\b/i;

export interface PlannerProposal {
  intent: StubIntent;
  /** The AI's body text shown in the assistant bubble. */
  body: string;
  /** Optional follow-up question shown beneath the body. */
  question?: string;
  /** Engine ops to apply on Approve. Empty array → nothing to apply. */
  ops: Op[];
  /** Whether this proposal is actionable (has ops + Approve makes sense). */
  actionable: boolean;
  /**
   * Word indices the proposal would additionally remove from the cut.
   * Used by App.tsx to compute the artifact preview's source ranges.
   * Empty unless the intent operates on transcript words.
   */
  deletedWordIndices: number[];
}

/** Classify a user prompt into one of our stub intents. */
export function classifyIntent(input: string): StubIntent {
  const t = input.trim().toLowerCase();
  if (!t) return "unknown";

  // "cut fillers", "remove fillers", "cut the ums", "remove ums and uhs"
  if (
    /\b(cut|remove|drop|strip|kill)\s+(the\s+)?(filler|fillers|ums?|uhs?|hmms?)\b/.test(t)
    || /\bremove\s+filler\s+words?\b/.test(t)
    || /\bauto-?clean\b/.test(t)
  ) {
    return "cut_fillers";
  }

  // "cut silences", "remove silence", "cut the silent parts"
  if (
    /\b(cut|remove|drop|strip|trim)\s+(the\s+)?(silence|silences|silent)\b/.test(t)
    || /\b(silence\s+strip|strip\s+silence)\b/.test(t)
  ) {
    return "cut_silences";
  }

  // Time range: "cut 2:23 to 3:45", "drop from 1:10 to 1:30",
  // "remove between 0:45 and 1:00", "trim 1:00 → 1:10".
  // Requires both a cut-verb and a parseable timestamp pair so we
  // don't false-positive on prompts that merely mention a time.
  if (CUT_VERB_RE.test(input) && parseTimeRange(input) !== null) {
    return "cut_range";
  }

  return "unknown";
}

/** Singular/plural and "noun" helper so the rationale reads naturally. */
function plural(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural ?? singular + "s")}`;
}

/** Compute a proposal from the user's prompt and the current transcript state. */
export function planFromUserPrompt(
  prompt: string,
  transcript: TranscriptState | null,
): PlannerProposal {
  const intent = classifyIntent(prompt);

  if (intent === "unknown") {
    return {
      intent,
      body:
        "I don't know how to do that yet. In Milestone A I only understand "
        + '"cut the fillers" and "cut the silences". '
        + "Real natural-language editing lands in Milestone B when Claude takes over.",
      ops: [],
      actionable: false,
      deletedWordIndices: [],
    };
  }

  if (transcript === null) {
    return {
      intent,
      body:
        "I can't act on that yet — there's no transcript loaded for the active video. "
        + "Switch to the Transcript tab and wait for Whisper to finish, or pick a video "
        + "in the folder pane.",
      ops: [],
      actionable: false,
      deletedWordIndices: [],
    };
  }

  if (intent === "cut_fillers") {
    const { ops, wordIndices } = buildFillerDeleteOps(transcript);
    if (ops.length === 0) {
      return {
        intent,
        body:
          "Scanned the transcript — no filler words I'd confidently remove. "
          + "The default set is conservative (um / uh / hmm / etc.); let me know "
          + "if you want a wider filter.",
        ops: [],
        actionable: false,
        deletedWordIndices: [],
      };
    }
    return {
      intent,
      body:
        `Found ${plural(wordIndices.length, "filler word")} to remove `
        + "(default set: um / uh / hmm / mhm / er / ah). "
        + "Approve to apply — you'll see the words strike through in the Transcript tab.",
      ops,
      actionable: true,
      deletedWordIndices: wordIndices,
    };
  }

  if (intent === "cut_range") {
    const range = parseTimeRange(prompt);
    if (range === null) {
      return {
        intent,
        body:
          "I caught a cut verb but couldn't parse a clean time range. "
          + 'Try something like "drop 2:23 to 3:45" or "cut from 1:00 to 1:30".',
        ops: [],
        actionable: false,
        deletedWordIndices: [],
      };
    }
    const { ops, wordIndices } = buildRangeDeleteOps(transcript, range.startSecs, range.endSecs);
    if (ops.length === 0) {
      return {
        intent,
        body:
          `${formatRange(range)} — that span has no transcript words I can remove. `
          + "Either the range is between words, the words there are already deleted, "
          + "or the source has no speech at that point.",
        ops: [],
        actionable: false,
        deletedWordIndices: [],
      };
    }
    return {
      intent,
      body:
        `${formatRange(range)} — removing ${plural(wordIndices.length, "word")} in that span. `
        + "Approve to apply.",
      ops,
      actionable: true,
      deletedWordIndices: wordIndices,
    };
  }

  // cut_silences — silence detection requires a separate sift-ai call.
  // We acknowledge the intent but defer the actual work to the next slice.
  return {
    intent,
    body:
      'Silence stripping isn\'t wired into the chat yet — for now, switch to the '
      + 'Transcript tab and use the "Auto-clean silences" controls there. '
      + "Chat-driven silence stripping lands in the next slice.",
    ops: [],
    actionable: false,
    deletedWordIndices: [],
  };
}

/** Pretty-print a (startSecs, endSecs) pair as "2:23 → 3:45". */
function formatRange(range: { startSecs: number; endSecs: number }): string {
  return `${formatSecs(range.startSecs)} → ${formatSecs(range.endSecs)}`;
}

function formatSecs(s: number): string {
  const total = Math.floor(s);
  const sec = total % 60;
  const min = Math.floor(total / 60) % 60;
  const hr = Math.floor(total / 3600);
  const ss = sec.toString().padStart(2, "0");
  if (hr > 0) {
    const mm = min.toString().padStart(2, "0");
    return `${hr}:${mm}:${ss}`;
  }
  return `${min}:${ss}`;
}

/**
 * Convenience wrapper around `planFromUserPrompt` that pulls the
 * transcript state from a `TranscriptHandle` ref.
 */
export function planFromHandle(
  prompt: string,
  handle: TranscriptHandle | null,
): PlannerProposal {
  const state = handle?.getState() ?? null;
  return planFromUserPrompt(prompt, state);
}
