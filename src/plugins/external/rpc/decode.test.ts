import { describe, expect, it } from "vitest";
import {
  decodeAgentHistoryCall,
  decodeDownloadRequest,
  decodeGuestMessage,
  decodeHookCall,
  decodeHostMessage,
  decodeSessionEvent,
  decodeSpawnOptions,
} from "./decode";

describe("wire decoders", () => {
  it("names a malformed guest call instead of half-reading it", () => {
    expect(() =>
      decodeGuestMessage({ kind: "call", id: 1, path: 7, args: [] }),
    ).toThrow("malformed rpc call");
  });

  it("names a malformed host result", () => {
    expect(() =>
      decodeHostMessage({ kind: "result", id: 1, ok: "yes" }),
    ).toThrow("malformed rpc result ok");
  });

  it("refuses a hook result that is not a plan", () => {
    expect(() =>
      decodeHookCall({
        agentId: "a",
        hook: "spawn.plan",
        input: {},
        output: { command: "x", args: [1], env: [] },
      }),
    ).toThrow("malformed agent hook call output");
  });

  it("refuses an unknown history method", () => {
    expect(() =>
      decodeAgentHistoryCall({ agentId: "a", method: "erase", args: [] }),
    ).toThrow("malformed agent history call method");
  });

  it("refuses spawn options without a terminal size", () => {
    expect(() => decodeSpawnOptions({ command: "x" })).toThrow(
      "malformed spawn options cols",
    );
  });

  it("refuses a download target with an unknown kind", () => {
    expect(() =>
      decodeDownloadRequest({
        id: "d",
        source: { url: "https://example.invalid/x" },
        target: { kind: "zip", path: "/tmp/x" },
      }),
    ).toThrow("malformed download target kind");
  });

  it("refuses session bytes outside one octet", () => {
    expect(() =>
      decodeSessionEvent({ type: "output", bytes: [0, 256] }),
    ).toThrow("malformed session output bytes");
  });
});
