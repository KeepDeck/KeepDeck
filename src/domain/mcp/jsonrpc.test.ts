import { describe, expect, it } from "vitest";
import { INTERNAL_ERROR, errorReply, requestIdOf } from "./jsonrpc";

describe("requestIdOf", () => {
  it("reads string and safe-integer ids, however the token was written", () => {
    expect(requestIdOf('{"id":7}')).toBe(7);
    expect(requestIdOf('{"id":"abc"}')).toBe("abc");
    // Mirrored in mcp_bridge.rs (same inputs): serde parses these as
    // FLOATS — the shared rule tests the value, so both sides answer the
    // integer.
    expect(requestIdOf('{"id":1e2}')).toBe(100);
    expect(requestIdOf('{"id":1.0}')).toBe(1);
  });

  it("degrades everything unroutable to null", () => {
    expect(requestIdOf("not json")).toBeNull();
    expect(requestIdOf('{"method":"x"}')).toBeNull();
    // Mirrored in mcp_bridge.rs (same inputs): the Rust timeout reply must
    // apply the same id rules or the two sides drift.
    expect(requestIdOf('{"id":true}')).toBeNull();
    expect(requestIdOf('{"id":1.5}')).toBeNull();
    expect(requestIdOf('{"id":{}}')).toBeNull();
    // Beyond 2^53 JSON.parse has already rounded — echoing would lie.
    expect(requestIdOf('{"id":9007199254740993}')).toBeNull();
    expect(requestIdOf('"just a string"')).toBeNull();
  });
});

describe("errorReply", () => {
  it("echoes the request id and carries the code", () => {
    const reply = JSON.parse(errorReply('{"id":3}', INTERNAL_ERROR, "boom"));
    expect(reply).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: { code: INTERNAL_ERROR, message: "boom" },
    });
  });

  it("answers garbage with a null id", () => {
    expect(JSON.parse(errorReply("garbage", INTERNAL_ERROR, "x")).id).toBeNull();
  });
});
