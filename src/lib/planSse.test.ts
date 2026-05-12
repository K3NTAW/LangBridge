import { describe, expect, it } from "vitest";

import { iterateSseDataLines, parseSseBlock } from "./planSse";

describe("parseSseBlock", () => {
  it("reads event and concatenates multi-line data", () => {
    const block = `event: rationale\ndata: {"type":"rationale","payload":{"text":"hi"}}\n`;
    expect(parseSseBlock(block)).toEqual({
      event: "rationale",
      data: '{"type":"rationale","payload":{"text":"hi"}}',
    });
  });
});

describe("iterateSseDataLines", () => {
  it("parses CRLF-delimited frames split across reads", async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode("event: done\r\ndata: {}\r\n\r\nevent: "));
        controller.enqueue(enc.encode("error\r\ndata: {\"x\":1}\r\n\r\n"));
        controller.close();
      },
    });

    const reader = stream.getReader();
    const out: { event: string; data: string }[] = [];
    for await (const ev of iterateSseDataLines(reader)) {
      out.push(ev);
    }
    expect(out).toEqual([
      { event: "done", data: "{}" },
      { event: "error", data: '{"x":1}' },
    ]);
  });
});
