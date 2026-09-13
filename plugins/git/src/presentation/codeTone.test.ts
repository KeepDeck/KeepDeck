import { describe, expect, it } from "vitest";
import { codeTone } from "./codeTone";
import type { ChangeRow } from "../domain/status";

const row = (code: string, kind: ChangeRow["kind"]): ChangeRow => ({
  path: "f.ts",
  origPath: null,
  code,
  kind,
});

describe("codeTone", () => {
  it("colours a code by its section — renames and type changes included", () => {
    expect(codeTone(row("M", "staged"))).toBe("staged");
    expect(codeTone(row("R", "staged"))).toBe("staged");
    expect(codeTone(row("T", "unstaged"))).toBe("unstaged");
    expect(codeTone(row("?", "untracked"))).toBe("untracked");
    expect(codeTone(row("A", "history"))).toBe("history");
  });

  it("a deletion is red in any section", () => {
    expect(codeTone(row("D", "staged"))).toBe("del");
    expect(codeTone(row("D", "unstaged"))).toBe("del");
    expect(codeTone(row("D", "history"))).toBe("del");
  });

  it("a conflict is red whatever its codes say", () => {
    expect(codeTone(row("UU", "conflicted"))).toBe("conflicted");
    expect(codeTone(row("DD", "conflicted"))).toBe("conflicted");
    expect(codeTone(row("U", "conflicted"))).toBe("conflicted");
  });
});
