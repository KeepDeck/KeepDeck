import { describe, expect, it } from "vitest";
import { noteKey, noteText } from "./diffNoteView";

describe("diff notes", () => {
  it("words each kind with the paths it carries", () => {
    expect(noteText({ kind: "mode", from: "100644", to: "100755" })).toBe(
      "File mode changed 100644 → 100755",
    );
    expect(noteText({ kind: "rename", from: "old.ts", to: "new.ts" })).toBe(
      "Renamed old.ts → new.ts",
    );
    expect(noteText({ kind: "copy", from: "a.ts", to: "b.ts" })).toBe("Copied from a.ts");
    expect(noteText({ kind: "unmerged" })).toContain("Unmerged");
  });

  it("keys a note by its kind and paths, so two renames in one diff stay apart", () => {
    expect(noteKey({ kind: "rename", from: "a", to: "b" })).not.toBe(
      noteKey({ kind: "rename", from: "a", to: "c" }),
    );
    expect(noteKey({ kind: "rename", from: "a", to: "b" })).not.toBe(
      noteKey({ kind: "copy", from: "a", to: "b" }),
    );
    expect(noteKey({ kind: "unmerged" })).toBe("unmerged");
  });
});
