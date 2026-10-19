import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { errorMessage, parseInstant, sha256Hex, shellQuote } from "./authoring";

describe("errorMessage", () => {
  it("takes an Error's message and a string as it is", () => {
    expect(errorMessage(new TypeError("bad"))).toBe("bad");
    expect(errorMessage(new Error("base"))).toBe("base");
    expect(errorMessage("plain")).toBe("plain");
  });

  it("renders anything else as JSON, never [object Object]", () => {
    expect(errorMessage({ code: 7, reason: "denied" })).toBe('{"code":7,"reason":"denied"}');
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(null)).toBe("null");
  });

  it("falls back to String when JSON cannot say it", () => {
    expect(errorMessage(undefined)).toBe("undefined");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(errorMessage(cyclic)).toBe("[object Object]");
  });
});

describe("shellQuote", () => {
  // The shell itself is the oracle: whatever goes in must come back out as
  // one argument, byte for byte.
  const echoed = (text: string) =>
    execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(text)}`]).toString();

  it("survives spaces, quotes and metacharacters as one word", () => {
    for (const text of [
      "/Applications/Keep Deck.app/x.sh",
      "it's",
      "a'b'c",
      "$HOME `x` ; rm -rf /",
      "",
    ]) {
      expect(echoed(text)).toBe(text);
    }
  });
});

describe("sha256Hex", () => {
  it("hashes the UTF-8 bytes as lowercase hex", async () => {
    for (const text of ["", "abc", "проект", "a\nb"]) {
      expect(await sha256Hex(text)).toBe(
        createHash("sha256").update(text, "utf8").digest("hex"),
      );
    }
  });
});

describe("parseInstant", () => {
  it("parses a timestamp string to epoch ms", () => {
    expect(parseInstant("2026-10-19T10:00:00.000Z")).toBe(Date.UTC(2026, 9, 19, 10));
  });

  it("answers null, never now, for anything it cannot read", () => {
    expect(parseInstant("not a date")).toBeNull();
    expect(parseInstant(1792360000000)).toBeNull();
    expect(parseInstant(undefined)).toBeNull();
    expect(parseInstant("")).toBeNull();
  });
});
