import { describe, expect, it } from "vitest";
import type { Workspace } from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { workspaceInitials, workspaceMarks } from "./workspaceMark";

const ws = (id: string, name: string, mark?: string): Workspace => ({
  id,
  instance: createWorkspaceInstance(),
  name,
  cwd: `/${id}`,
  worktreeBaseDir: null,
  panes: [],
  ...(mark !== undefined && { mark }),
});
const marksOf = (deck: Workspace[]) => deck.map((w) => workspaceMarks(deck).get(w.id));

describe("workspaceInitials", () => {
  it("takes two words' initials, else a word's first two letters, case as typed", () => {
    expect(workspaceInitials("KeepDeck")).toBe("KD");
    expect(workspaceInitials("keepdeck.ai")).toBe("ka");
    expect(workspaceInitials("web app")).toBe("wa");
    expect(workspaceInitials("mnemo")).toBe("mn");
    expect(workspaceInitials("24/7 bot")).toBe("27");
    expect(workspaceInitials("")).toBe("?");
  });

  it("takes whole characters of any script, and skips a word with no letter in it", () => {
    expect(workspaceInitials("Разработка")).toBe("Ра");
    expect(workspaceInitials("Тест проект")).toBe("Тп");
    expect(workspaceInitials("项目")).toBe("项目");
    // Not half of the rocket: the emoji is no word here.
    expect(workspaceInitials("🚀 ship")).toBe("sh");
  });
});

describe("workspaceMarks — unique across the deck", () => {
  it("walks the KeepDeck three apart: KD, KW, Kp — the first one keeps the plain initials", () => {
    expect(marksOf([ws("a", "KeepDeck"), ws("b", "KeepDeck Web"), ws("c", "KeepDeck promo")])).toEqual(["KD", "KW", "Kp"]);
  });

  it("gives two of one name the next rung, and the digit when the ladder runs out", () => {
    expect(marksOf([ws("a", "Test"), ws("b", "Test")])).toEqual(["Te", "Tt"]);
    expect(marksOf([ws("a", "x"), ws("b", "x"), ws("c", "x")])).toEqual(["x", "x2", "x3"]);
  });

  it("lets deck order decide who keeps the plain initials", () => {
    expect(marksOf([ws("b", "KeepDeck Web"), ws("a", "KeepDeck")])).toEqual(["KD", "Ke"]);
  });

  it("never changes the person's own letters, and takes them out of everyone else's reach", () => {
    // A chosen KD on Languages claims it: KeepDeck walks past it.
    expect(marksOf([ws("a", "KeepDeck"), ws("b", "Languages", "KD"), ws("c", "KeepDeck Web")])).toEqual(["Ke", "KD", "KW"]);
  });

  it("leaves a deck with nothing in common as it was", () => {
    expect(marksOf([ws("a", "Mnemo"), ws("b", "Roblox"), ws("c", "isp team")])).toEqual(["Mn", "Ro", "it"]);
  });
});
