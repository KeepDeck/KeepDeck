import { describe, expect, it } from "vitest";
import { COMMAND_DOCS } from "./commandList";
import { helpView, templateParts } from "./helpView";

describe("templateParts", () => {
  it("splits a template into text and <slots>", () => {
    expect(templateParts("switch to <workspace>")).toEqual([
      { text: "switch to ", slot: false },
      { text: "<workspace>", slot: true },
    ]);
  });
});

describe("helpView", () => {
  it("names the live chords, every command, and what Escape does in both phases", () => {
    const view = helpView("⌥Space", "⌥⇧Space");
    expect(view.command.keys).toBe("⌥Space");
    expect(view.dictation.keys).toBe("⌥⇧Space");
    expect(view.commands).toHaveLength(COMMAND_DOCS.length);
    expect(view.escape.text).toContain("transcribing");
  });

  it("does not promise commands in any language", () => {
    expect(helpView("a", "b").note).toContain("English and Russian");
  });
});
