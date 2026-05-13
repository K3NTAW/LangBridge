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
  type TranscriptHandle,
  type TranscriptState,
} from "./transcriptOps";

export type StubIntent = "cut_fillers" | "cut_silences" | "unknown";

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
