import { describe, expect, it } from "vitest";
import type { JournalRecords, SessionRecord, SessionRecordBase } from "../../journal/sessionLog";
import { usageEvent } from "../history/event.testSupport";
import { dimensionKey } from "./dimensions";
import { rowTeam, teamHistory } from "./teams";

const at = (iso: string) => Date.parse(iso);
const record = (over: Partial<SessionRecordBase>): SessionRecord => ({
  agent: "claude",
  sessionId: "s",
  cwd: "/repo",
  boundAt: "2026-11-01T10:00:00Z",
  ...over,
  state: "closed",
  endedAt: "2026-11-01T12:00:00Z",
});

const journal: JournalRecords = {
  "ws-1": [
    record({ sessionId: "bound", team: "statistics", branch: "kd/8", boundAt: "2026-11-05T10:00:00Z" }),
    record({ sessionId: "early", team: "artifacts", branch: "kd/1", boundAt: "2026-10-01T10:00:00Z" }),
    record({ sessionId: "later", team: "mcp", branch: "kd/1", boundAt: "2026-10-20T10:00:00Z" }),
    record({ sessionId: "loner" }),
  ],
};
const history = teamHistory(journal);

describe("a row's team", () => {
  it("is the recorded team first — the journal never overrides what capture recorded", () => {
    const row = usageEvent({ agent: "claude", sessionId: "bound", team: { id: "team-9", name: "renamed", role: "lead" } });
    expect(rowTeam(row, history)).toEqual({ name: "renamed", source: "recorded" });
  });

  it("is the journal's team for a session it bound, by agent and session", () => {
    expect(rowTeam(usageEvent({ agent: "claude", sessionId: "bound" }), history)).toEqual({ name: "statistics", source: "journal" });
    // The same id under another CLI is another session.
    expect(rowTeam(usageEvent({ agent: "codex", sessionId: "bound" }), history).source).toBe("unknown");
  });

  it("is the branch's holder AT THE ROW'S TIME, not its current one", () => {
    const on = (iso: string) => usageEvent({ agent: "kimi", sessionId: "x", occurredAt: at(iso), worktree: { path: "/w", repo: "/r", branch: "kd/1" } });
    expect(rowTeam(on("2026-10-10T00:00:00Z"), history)).toEqual({ name: "artifacts", source: "branch" });
    expect(rowTeam(on("2026-10-25T00:00:00Z"), history)).toEqual({ name: "mcp", source: "branch" });
    // Before the branch's first recorded team, nobody held it that we know of.
    expect(rowTeam(on("2026-09-01T00:00:00Z"), history)).toEqual({ name: null, source: "unknown" });
  });

  it("is unknown with no record, no team on the record, and no branch", () => {
    expect(rowTeam(usageEvent({ agent: "claude", sessionId: "loner" }), history)).toEqual({ name: null, source: "unknown" });
    expect(rowTeam(usageEvent({ sessionId: "nobody" }), teamHistory({}))).toEqual({ name: null, source: "unknown" });
  });

  it("groups a team within its workspace — the same name in two workspaces is two teams", () => {
    const a = usageEvent({ workspaceName: "Languages", team: { id: "t1", name: "Team 1", role: "lead" } });
    const b = usageEvent({ workspaceName: "Dragon", team: { id: "t2", name: "Team 1", role: "lead" } });
    expect(dimensionKey("team", a, history)).not.toBe(dimensionKey("team", b, history));
  });
});
