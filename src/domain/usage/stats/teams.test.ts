import { describe, expect, it } from "vitest";
import type { JournalRecords, SessionRecord, SessionRecordBase } from "../../journal/sessionLog";
import { usageEvent } from "../history/event.testSupport";
import { dimensionKey } from "./dimensions";
import { rowTeam, teamHistory, teamProvenance } from "./teams";

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
  "ws-2": [record({ sessionId: "other-ws", team: "website", branch: "kd/1", boundAt: "2026-10-05T10:00:00Z" })],
};
const NAMES = new Map([["ws-1", "KeepDeck"], ["ws-2", "Website"]]);
const history = teamHistory(journal, NAMES);
const MEMBER = { kind: "member" as const, id: "team-9", name: "renamed", role: "lead" };

describe("a row's team", () => {
  it("is what capture recorded — a team, or no team, never inferred over", () => {
    expect(rowTeam(usageEvent({ agent: "claude", sessionId: "bound", team: MEMBER }), history)).toEqual({
      kind: "member", name: "renamed", source: "recorded",
    });
    // A pane on no team is a fact: the session's journal team must not claim it.
    expect(rowTeam(usageEvent({ agent: "claude", sessionId: "bound", team: { kind: "none" } }), history)).toEqual({ kind: "none" });
  });

  it("is the journal's team for a session booked before teams were recorded, by agent and session", () => {
    expect(rowTeam(usageEvent({ agent: "claude", sessionId: "bound" }), history)).toEqual({
      kind: "member", name: "statistics", source: "journal",
    });
    expect(rowTeam(usageEvent({ agent: "codex", sessionId: "bound" }), history)).toEqual({ kind: "unknown" });
  });

  it("lets a later binding on no team answer: it names no team to infer", () => {
    const leftTeam = teamHistory(
      {
        "ws-2": [record({ sessionId: "left", boundAt: "2026-10-09T00:00:00Z" })],
        "ws-1": [record({ sessionId: "left", team: "old", branch: "kd/1", boundAt: "2026-10-01T00:00:00Z" })],
      },
      NAMES,
    );
    // Not even the branch's holder answers for it: the session said no team.
    const row = usageEvent({
      agent: "claude", sessionId: "left", workspaceId: "ws-1", workspaceName: "KeepDeck",
      occurredAt: at("2026-10-10T00:00:00Z"), worktree: { path: "/w", repo: "/r", branch: "kd/1" },
    });
    expect(rowTeam(row, leftTeam)).toEqual({ kind: "unknown" });
  });

  it("takes the session's LATEST binding when two workspaces recorded it", () => {
    const twice = teamHistory(
      {
        // The newer binding is read FIRST: order of reading must not decide.
        "ws-2": [record({ sessionId: "moved", team: "new", boundAt: "2026-10-09T00:00:00Z" })],
        "ws-1": [record({ sessionId: "moved", team: "old", boundAt: "2026-10-01T00:00:00Z" })],
      },
      NAMES,
    );
    expect(rowTeam(usageEvent({ agent: "claude", sessionId: "moved" }), twice)).toMatchObject({ name: "new" });
  });

  it("is the branch's holder in the row's OWN workspace, at the row's time", () => {
    const on = (iso: string, workspaceId = "ws-1", workspaceName = "KeepDeck") =>
      usageEvent({ agent: "kimi", sessionId: "x", workspaceId, workspaceName, occurredAt: at(iso), worktree: { path: "/w", repo: "/r", branch: "kd/1" } });
    expect(rowTeam(on("2026-10-10T00:00:00Z"), history)).toMatchObject({ name: "artifacts", source: "branch" });
    expect(rowTeam(on("2026-10-25T00:00:00Z"), history)).toMatchObject({ name: "mcp", source: "branch" });
    // Another workspace's kd/1 is another branch.
    expect(rowTeam(on("2026-10-10T00:00:00Z", "ws-2", "Website"), history)).toMatchObject({ name: "website" });
    // Two workspaces of ONE name are still two: the slot decides, not the name.
    const twins = teamHistory(journal, new Map([["ws-1", "Same"], ["ws-2", "Same"]]));
    expect(rowTeam(on("2026-10-10T00:00:00Z", "ws-2", "Same"), twins)).toMatchObject({ name: "website" });
    // A slot now holding another workspace (or renamed) answers for nothing.
    expect(rowTeam(on("2026-10-10T00:00:00Z", "ws-1", "Elsewhere"), history)).toEqual({ kind: "unknown" });
    // Before the branch's first recorded team, nobody held it that we know of.
    expect(rowTeam(on("2026-09-01T00:00:00Z"), history)).toEqual({ kind: "unknown" });
  });

  it("is unknown with no record, no team on the record, and no branch", () => {
    expect(rowTeam(usageEvent({ agent: "claude", sessionId: "loner" }), history)).toEqual({ kind: "unknown" });
    expect(rowTeam(usageEvent({ sessionId: "nobody" }), teamHistory({}, NAMES))).toEqual({ kind: "unknown" });
  });
});

describe("team groups", () => {
  it("are a team within its workspace, with no team and unknown each a group of their own", () => {
    const a = usageEvent({ workspaceName: "Languages", team: { ...MEMBER, name: "Team 1" } });
    const b = usageEvent({ workspaceName: "Dragon", team: { ...MEMBER, name: "Team 1" } });
    const none = usageEvent({ workspaceName: "Dragon", team: { kind: "none" } });
    const unknown = usageEvent({ workspaceName: "Dragon", sessionId: "nobody" });
    const keys = [a, b, none, unknown].map((row) => dimensionKey("team", row, history));
    expect(new Set(keys).size).toBe(4);
  });

  it("are inferred, recorded or mixed over EVERY row — a newer recorded row never hides an older inferred one", () => {
    const inferred = usageEvent({ agent: "claude", sessionId: "bound", workspaceName: "KeepDeck", occurredAt: 1 });
    const recorded = usageEvent({ workspaceName: "KeepDeck", team: { ...MEMBER, name: "statistics" }, occurredAt: 2 });
    const key = dimensionKey("team", recorded, history);
    expect(teamProvenance([inferred, recorded], history).get(key)).toBe("mixed");
    expect(teamProvenance([recorded], history).get(key)).toBe("recorded");
    expect(teamProvenance([inferred], history).get(key)).toBe("inferred");
  });
});
