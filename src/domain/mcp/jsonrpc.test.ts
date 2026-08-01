import { describe, expect, it } from "vitest";
import { INTERNAL_ERROR, errorReply, requestIdOf } from "./jsonrpc";

describe("requestIdOf", () => {
  it("reads string and integer ids", () => {
    expect(requestIdOf('{"id":7}')).toBe(7);
    expect(requestIdOf('{"id":"abc"}')).toBe("abc");
  });

  it("degrades everything unroutable to null", () => {
    expect(requestIdOf("not json")).toBeNull();
    expect(requestIdOf('{"method":"x"}')).toBeNull();
    expect(requestIdOf('{"id":true}')).toBeNull();
    expect(requestIdOf('{"id":1.5}')).toBeNull();
    expect(requestIdOf('{"id":{}}')).toBeNull();
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
