import { describe, expect, it } from "vitest";
import { directoryStateOf } from "./agentLocationView";

describe("directoryStateOf", () => {
  it("holds a folder a worktree is made or removed in, over a team on it; a team's is worked in; else free", () => {
    expect(directoryStateOf([{ kind: "team", team: "team-1" }, { kind: "creation", op: 3 }])).toBe("held");
    expect(directoryStateOf([{ kind: "removal", op: 4 }])).toBe("held");
    expect(directoryStateOf([{ kind: "session", session: 9 }, { kind: "team", team: "team-1" }])).toBe("worked-in");
    expect(directoryStateOf([{ kind: "session", session: 9 }])).toBe("free");
    expect(directoryStateOf([])).toBe("free");
  });
});
