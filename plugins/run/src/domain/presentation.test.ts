import { describe, expect, it } from "vitest";
import { commandBanner, exitNote, spawnFailedNote } from "./presentation";

describe("commandBanner", () => {
  it("wraps the command in a dim [run] echo terminated by CRLF", () => {
    expect(commandBanner("pnpm dev")).toBe("\x1b[90m[run] pnpm dev\x1b[0m\r\n");
  });

  it("normalizes bare and CRLF newlines to CRLF so lines don't stair-step", () => {
    expect(commandBanner("a\nb\r\nc")).toBe("\x1b[90m[run] a\r\nb\r\nc\x1b[0m\r\n");
  });
});

describe("exitNote", () => {
  it("says [stopped] when the user pulled the plug, ignoring the exit code", () => {
    expect(exitNote({ stopped: true, code: 137 })).toBe("\r\n\x1b[90m[stopped]\x1b[0m\r\n");
  });

  it("reports the exit code when the process ended on its own", () => {
    expect(exitNote({ stopped: false, code: 1 })).toBe(
      "\r\n\x1b[90m[process exited (1)]\x1b[0m\r\n",
    );
  });

  it("omits the code when there is none", () => {
    expect(exitNote({ stopped: false, code: null })).toBe(
      "\r\n\x1b[90m[process exited]\x1b[0m\r\n",
    );
    expect(exitNote({ stopped: false })).toBe("\r\n\x1b[90m[process exited]\x1b[0m\r\n");
  });
});

describe("spawnFailedNote", () => {
  it("renders the OS error in red so the why is visible", () => {
    expect(spawnFailedNote("no such file or directory")).toBe(
      "\x1b[31mspawn failed: no such file or directory\x1b[0m\r\n",
    );
  });
});
