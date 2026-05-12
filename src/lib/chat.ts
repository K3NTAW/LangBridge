/**
 * Chat history per Sift project.
 *
 * Persisted as JSON-Lines at `<folder>/.sift/chat.log` — one event per
 * line, append-only, easy to tail in a terminal. Each turn pairs a
 * user command with the AI's response (rationale + ops applied).
 *
 * Status: stubs. Implementation lands in Milestone B.
 */
import type { Op } from "./ops";

/** A single user → AI exchange. */
export interface ChatTurn {
  /** Monotonic id (ULID) for this turn. */
  id: string;
  /** Epoch ms when the user submitted. */
  createdAt: number;
  /** What the user typed. */
  userCommand: string;
  /** AI rationale for the proposed edit. */
  rationale: string;
  /** The ops the AI proposed (and the user accepted; rejected turns aren't logged). */
  ops: Op[];
  /** True if the user later undid this turn. */
  undone: boolean;
}

/** Read the full chat history for a project. Empty array if none. */
export async function loadChatHistory(_chatLogPath: string): Promise<ChatTurn[]> {
  throw new Error("loadChatHistory: not implemented yet (Milestone B)");
}

/** Append a new turn to disk. */
export async function appendChatTurn(_chatLogPath: string, _turn: ChatTurn): Promise<void> {
  throw new Error("appendChatTurn: not implemented yet (Milestone B)");
}

/** Mark a previously-applied turn as undone (for the UI strikethrough). */
export async function markChatTurnUndone(_chatLogPath: string, _turnId: string): Promise<void> {
  throw new Error("markChatTurnUndone: not implemented yet (Milestone B)");
}
