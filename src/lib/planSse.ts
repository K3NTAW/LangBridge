/**
 * Minimal SSE frame parsing for `POST /v1/plan` (`text/event-stream`).
 *
 * Exported for unit tests — keeps [`aiClient`](./aiClient.ts) readable.
 */

/** Parse one SSE block (lines between blank-line separators, already CRLF-normalized). */
export function parseSseBlock(block: string): { event: string; data: string } {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  return { event, data: dataLines.join("\n") };
}

/**
 * Incrementally read UTF-8 chunks and yield `{ event, data }` for each SSE message.
 */
export async function* iterateSseDataLines(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }, void, undefined> {
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value !== undefined) {
      buf += decoder.decode(value, { stream: true });
    }
    buf = buf.replace(/\r\n/g, "\n");
    for (;;) {
      const sep = buf.indexOf("\n\n");
      if (sep < 0) break;
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const trimmed = block.trim();
      if (!trimmed) continue;
      const ev = parseSseBlock(trimmed);
      if (ev.data.length > 0) yield ev;
    }
    if (done) break;
  }
}
