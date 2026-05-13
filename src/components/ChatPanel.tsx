/**
 * ChatPanel — right-pane editing surface.
 *
 * Design-system v0.1: thin panel header (label + Thinking pill / Clear),
 * scrollable message list with right-aligned user bubbles and left-aligned
 * AI messages (rationale + question + artifact cards), composer at the
 * bottom with a Range chip + send button + ⌘↵ hint.
 */
import {
  ArrowUp,
  Check,
  ChevronRight,
  Loader2,
  Maximize2,
  Play,
  Scissors,
  Sparkles,
  Trash2,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

export type ChatMessageRole = "user" | "assistant";

export interface ChatArtifact {
  id: string;
  caption: string;
  blobUrl: string | null;
  rendering: boolean;
  error: string | null;
}

export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  body: string;
  question?: string | null | undefined;
  artifacts?: ChatArtifact[] | undefined;
  applied?: boolean | undefined;
  createdAt: number;
}

interface Props {
  messages: ChatMessage[];
  busy: boolean;
  onSubmit: (text: string) => void | Promise<void>;
  onApprove: (messageId: string) => void;
  onUndo: (messageId: string) => void;
  onOpenInPlayer: (artifact: ChatArtifact) => void;
  onClearChat?: () => void;
  /** Called when the user clicks the collapse chevron in the panel header. */
  onCollapse?: () => void;
  disabled?: boolean;
  disabledReason?: string | undefined;
}

const EXAMPLES = [
  "cut the silences",
  'remove every "um"',
  "tighten the intro",
  "from 2:23 to 3:45, drop the b-roll bit",
];

export function ChatPanel({
  messages,
  busy,
  onSubmit,
  onApprove,
  onUndo,
  onOpenInPlayer,
  onClearChat,
  onCollapse,
  disabled = false,
  disabledReason,
}: Props) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const submit = useCallback(
    async (e?: FormEvent, override?: string) => {
      e?.preventDefault();
      const text = (override ?? draft).trim();
      if (!text || disabled || busy) return;
      if (override === undefined) setDraft("");
      await onSubmit(text);
    },
    [draft, disabled, busy, onSubmit],
  );

  return (
    <div className="panel chat-panel">
      <div className="panel-header">
        <div className="panel-title">Chat</div>
        <div className="spacer" />
        {busy ? (
          <span className="thinking">
            <Loader2 size={10} strokeWidth={2} />
            Thinking…
          </span>
        ) : null}
        {!busy && onClearChat && messages.length > 0 ? (
          <button
            type="button"
            className="btn is-tertiary is-xs"
            onClick={onClearChat}
            title="Clear chat history"
          >
            <Trash2 size={11} strokeWidth={2} />
            Clear
          </button>
        ) : null}
        {onCollapse ? (
          <button
            type="button"
            className="btn-collapse"
            onClick={onCollapse}
            title="Collapse chat pane"
            aria-label="Collapse chat pane"
          >
            <ChevronRight size={13} strokeWidth={2} />
          </button>
        ) : null}
      </div>

      {messages.length === 0 ? (
        <ChatEmpty
          onPick={(text) => void submit(undefined, text)}
          disabled={disabled || busy}
        />
      ) : (
        <div ref={scrollRef} className="chat-body">
          {messages.map((m) => (
            <Bubble
              key={m.id}
              message={m}
              onApprove={() => onApprove(m.id)}
              onUndo={() => onUndo(m.id)}
              onOpenInPlayer={onOpenInPlayer}
            />
          ))}
        </div>
      )}

      <form
        onSubmit={(e) => void submit(e)}
        className={`chat-composer ${disabled ? "is-disabled" : ""}`}
      >
        <div className="field">
          <textarea
            value={draft}
            disabled={disabled || busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={
              disabled
                ? (disabledReason ?? "Open a folder to start chatting.")
                : "Tell Sift what to change."
            }
            rows={2}
          />
          <div className="row">
            <button
              type="button"
              className="btn is-tertiary is-xs"
              disabled={disabled || busy}
              title="Attach a clip range (coming soon)"
            >
              <Scissors size={11} strokeWidth={2} />
              Range
            </button>
            <span className="hint">⌘↵ to send</span>
            <button
              type="submit"
              className="send"
              disabled={disabled || busy || draft.trim() === ""}
              aria-label="Send message"
            >
              <ArrowUp size={14} strokeWidth={2.5} />
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function ChatEmpty({
  onPick,
  disabled,
}: {
  onPick: (text: string) => void;
  disabled: boolean;
}) {
  return (
    <div
      className="chat-body"
      style={{
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
      }}
    >
      <div style={{ maxWidth: 240, width: "100%" }}>
        <div
          className="empty-headline"
          style={{
            marginBottom: 14,
            fontFamily: "var(--font-display)",
          }}
        >
          Tell Sift what you want.
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            alignItems: "stretch",
          }}
        >
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              className="example-prompt"
              onClick={() => onPick(ex)}
              disabled={disabled}
            >
              <Sparkles
                size={11}
                strokeWidth={2}
                style={{ color: "var(--accent-primary)", flex: "0 0 auto" }}
              />
              <span>{ex}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Bubble({
  message,
  onApprove,
  onUndo,
  onOpenInPlayer,
}: {
  message: ChatMessage;
  onApprove: () => void;
  onUndo: () => void;
  onOpenInPlayer: (a: ChatArtifact) => void;
}) {
  if (message.role === "user") {
    return <div className="msg-user">{message.body}</div>;
  }
  return (
    <div className="msg-ai">
      <div className="ai-body">{message.body}</div>
      {message.question ? <div className="ai-question">{message.question}</div> : null}
      {message.artifacts?.map((a) => (
        <Artifact
          key={a.id}
          artifact={a}
          applied={Boolean(message.applied)}
          onApprove={onApprove}
          onUndo={onUndo}
          onOpenInPlayer={() => onOpenInPlayer(a)}
        />
      ))}
    </div>
  );
}

function Artifact({
  artifact,
  applied,
  onApprove,
  onUndo,
  onOpenInPlayer,
}: {
  artifact: ChatArtifact;
  applied: boolean;
  onApprove: () => void;
  onUndo: () => void;
  onOpenInPlayer: () => void;
}) {
  return (
    <div className="artifact">
      <div className="caption">
        <span className="lbl">{artifact.caption}</span>
        {applied ? (
          <>
            <span className="sep">·</span>
            <span style={{ color: "var(--accent-success)" }}>applied</span>
          </>
        ) : null}
      </div>
      <div className="v-stage">
        {artifact.blobUrl ? (
          <video
            src={artifact.blobUrl}
            controls
            playsInline
            preload="metadata"
          />
        ) : artifact.rendering ? (
          <span className="placeholder">
            <Loader2 size={12} strokeWidth={2} className="spin" />
            Rendering snippet…
          </span>
        ) : artifact.error ? (
          <span className="placeholder" style={{ color: "var(--accent-warn)" }}>
            {artifact.error}
          </span>
        ) : (
          <Play size={28} strokeWidth={1.5} style={{ color: "var(--fg-faint)" }} />
        )}
      </div>
      <div className="actions">
        {applied ? (
          <button
            type="button"
            className="btn is-tertiary is-xs"
            onClick={onUndo}
            title="Undo this batch"
          >
            <Undo2 size={11} strokeWidth={2} />
            Undo
          </button>
        ) : (
          <button
            type="button"
            className="btn is-primary is-sm"
            onClick={onApprove}
            disabled={!artifact.blobUrl}
            title={artifact.blobUrl ? "Apply this edit" : "Waiting for preview"}
          >
            <Check size={11} strokeWidth={2.5} />
            Approve
          </button>
        )}
        <button
          type="button"
          className="btn is-tertiary is-xs"
          onClick={onOpenInPlayer}
          disabled={!artifact.blobUrl}
          title="Open this snippet in the big player"
        >
          <Maximize2 size={11} strokeWidth={2} />
          Open
        </button>
        <div className="spacer" />
      </div>
    </div>
  );
}
