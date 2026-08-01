import { describe, expect, it } from "vitest";
import { shellLine } from "./shellLine";

describe("shellLine", () => {
  it("leaves the common spaceless invocation bare", () => {
    expect(
      shellLine({
        command: "/Applications/KeepDeck.app/Contents/MacOS/KeepDeck",
        args: ["--mcp-shim", "/Users/u/.config/keepdeck/mcp/mcp.sock"],
      }),
    ).toBe(
      "/Applications/KeepDeck.app/Contents/MacOS/KeepDeck --mcp-shim /Users/u/.config/keepdeck/mcp/mcp.sock",
    );
  });

  it("single-quotes anything a shell would touch", () => {
    // Spaces split; $ and backticks EXPAND inside double quotes — the exact
    // leak the round-2 review demonstrated. Single quotes silence them all.
    expect(shellLine({ command: "/Apps/My App/kd", args: [] })).toBe(
      "'/Apps/My App/kd'",
    );
    expect(shellLine({ command: "/Apps/$HOME/kd", args: [] })).toBe(
      "'/Apps/$HOME/kd'",
    );
    expect(shellLine({ command: "/Apps/`id`/kd", args: [] })).toBe(
      "'/Apps/`id`/kd'",
    );
    expect(shellLine({ command: "/Apps/a*(b)/kd", args: [] })).toBe(
      "'/Apps/a*(b)/kd'",
    );
  });

  it("splices embedded single quotes", () => {
    expect(shellLine({ command: "/Apps/o'brien/kd", args: [] })).toBe(
      "'/Apps/o'\\''brien/kd'",
    );
  });

  it("an empty word still becomes a word", () => {
    expect(shellLine({ command: "/kd", args: [""] })).toBe("/kd ''");
  });
});
