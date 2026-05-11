import { describe, expect, it } from "vitest";

import {
  EngineError,
  __setEngineClientForTests,
  getEngineClient,
} from "./engineClient";

describe("EngineError.fromInvokeError", () => {
  it("parses the Tauri error string emitted by the Rust bridge", () => {
    const e = EngineError.fromInvokeError("engine error -32002: no project loaded");
    expect(e).toBeInstanceOf(EngineError);
    expect(e.code).toBe(-32002);
    expect(e.message).toBe("no project loaded");
  });

  it("handles negative-code errors with leading whitespace in message", () => {
    const e = EngineError.fromInvokeError("engine error -32602:    bad params");
    expect(e.code).toBe(-32602);
    expect(e.message).toBe("bad params");
  });

  it("falls back to the raw message for unparseable errors", () => {
    const e = EngineError.fromInvokeError("connect: no such file");
    expect(e.code).toBeUndefined();
    expect(e.message).toBe("connect: no such file");
  });

  it("stringifies non-string inputs", () => {
    const e = EngineError.fromInvokeError({ unexpected: true });
    expect(e.code).toBeUndefined();
    expect(e.message.length).toBeGreaterThan(0);
  });
});

describe("getEngineClient (outside Tauri)", () => {
  it("returns a client whose calls throw EngineError when not in Tauri", async () => {
    __setEngineClientForTests(null);
    const c = getEngineClient();
    await expect(c.info()).rejects.toBeInstanceOf(EngineError);
    await expect(c.head()).rejects.toBeInstanceOf(EngineError);
    await expect(c.newProject()).rejects.toBeInstanceOf(EngineError);
    __setEngineClientForTests(null);
  });
});
