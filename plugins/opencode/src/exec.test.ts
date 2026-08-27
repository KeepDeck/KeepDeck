import { describe, expect, it } from "vitest";
import { extractJson, tail } from "./exec";

/**
 * The scanner could not be reached without spawning something while it lived
 * inside the fork recipe. It is a reader for one text protocol and nothing
 * else, so these are the cases that protocol actually produces.
 */
describe("reading what opencode printed", () => {
  it("takes the payload out from under the line that rides ahead of it", () => {
    const text = 'Exporting session: ses_1\r\n{"info":{"id":"ses_1"}}';
    expect(extractJson(text)).toBe('{"info":{"id":"ses_1"}}');
  });

  /**
   * The reason it is a scanner and not a slice from the first `{` to the last
   * `}`: stdout is a TTY, so opencode may print after the payload as well as
   * before it.
   */
  it("stops at the payload's own closing brace, not the last one in the output", () => {
    const text = '{"a":1}\r\nDone {not json}\r\n';
    expect(extractJson(text)).toBe('{"a":1}');
  });

  it("is not fooled by braces inside strings", () => {
    const text = '{"title":"a } brace","n":1}';
    expect(extractJson(text)).toBe(text);
  });

  it("is not fooled by an escaped quote before one", () => {
    const text = '{"title":"say \\"}\\" once","n":1}';
    expect(extractJson(text)).toBe(text);
  });

  it("says so when there is no payload at all", () => {
    expect(() => extractJson("error: no such session\r\n")).toThrow(
      /no JSON payload/,
    );
  });

  /**
   * A truncated payload has to fail here rather than reach `JSON.parse` as a
   * shorter, still-parseable object — the import that followed would write a
   * conversation with its tail missing.
   */
  it("says so when the payload was cut off", () => {
    expect(() => extractJson('{"info":{"id":"ses_1"}')).toThrow(
      /truncated or unbalanced/,
    );
  });

  it("keeps the end of a failed command's output, which is where it says why", () => {
    expect(tail(`${"noise ".repeat(100)}fatal: nope`)).toMatch(/fatal: nope$/);
    expect(tail("  short  ")).toBe("short");
  });
});
