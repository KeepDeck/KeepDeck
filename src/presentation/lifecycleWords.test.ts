import { describe, expect, it } from "vitest";
import { TEAM_FULL_MESSAGE } from "../domain/deck";
import type { NoAnswer, OwnerRefusal, Refusal, Standing } from "../domain/lifecycle";
import { intentOutcomeText, noAnswerText, ownerRefusalText, refusalText, standingNotice } from "./lifecycleWords";
import { sessionHeldText } from "./resumeWords";

const refusals: Refusal[] = [
  { kind: "alreadyClosing" },
  { kind: "busy" },
  { kind: "notFound" },
  { kind: "barrierUp" },
  { kind: "journalUnavailable" },
  { kind: "journalStuck" },
  { kind: "locationHeld" },
  { kind: "targetLeaving" },
  { kind: "archived" },
  { kind: "sessionsDown" },
  { kind: "forkStepExpired" },
  { kind: "planExpired" },
  { kind: "forkUnfinished" },
  { kind: "changed" },
  { kind: "rejected", why: { kind: "role", why: "taken", role: "lead" } },
];
const silences: NoAnswer[] = [{ kind: "unavailable" }, { kind: "unknown" }];

describe("the lifecycle's words", () => {
  it("say each refusal kind in its own sentence, borrowed from no other", () => {
    const said = refusals.map(refusalText);
    expect(said.every((text) => text.trim().length > 0)).toBe(true);
    expect(new Set(said).size).toBe(said.length);
  });

  it("say an owner's refusal by its kind, and one this build does not know without guessing", () => {
    const owners: OwnerRefusal[] = [
      { kind: "gone", what: "workspace" },
      { kind: "gone", what: "team" },
      { kind: "gone", what: "agent" },
      { kind: "unreadable", what: "agent" },
      { kind: "notTaken", what: "team" },
      { kind: "notTaken", what: "move" },
      { kind: "teamFull" },
      { kind: "role", why: "taken", role: "lead" },
      { kind: "sessionHeld" },
      { kind: "noBranch" },
      { kind: "wrongOwner", command: "addTeam" },
      { kind: "failed" },
      { kind: "unknown" },
    ];
    const said = owners.map(ownerRefusalText);
    expect(new Set(said).size).toBe(said.length);
    expect(refusalText({ kind: "rejected", why: { kind: "teamFull" } })).toBe(TEAM_FULL_MESSAGE);
    expect(refusalText({ kind: "rejected", why: { kind: "sessionHeld" } })).toBe(sessionHeldText());
    expect(refusalText({ kind: "rejected", why: "an older build's sentence" })).toBe(ownerRefusalText({ kind: "unknown" }));
    expect(ownerRefusalText({ kind: "failed" })).not.toMatch(/Error|undefined/);
  });

  it("tell a write that did not happen from one that may still", () => {
    expect(refusalText({ kind: "journalUnavailable" })).toContain("nothing was done");
    expect(refusalText({ kind: "journalStuck" })).toContain("may still be done");
    expect(noAnswerText({ kind: "unavailable" })).toContain("nothing was done");
    expect(noAnswerText({ kind: "unknown" })).toContain("whether this was done");
  });

  it("say each way the door comes back without an answer apart from every refusal", () => {
    const said = silences.map(noAnswerText);
    expect(new Set([...said, ...refusals.map(refusalText)]).size).toBe(said.length + refusals.length);
  });

  it("word an intent's outcome by what ended it, and say nothing for one taken on", () => {
    expect(intentOutcomeText({ kind: "accepted", op: 1, minted: { workspace: null, team: null, panes: [] } })).toBeNull();
    expect(intentOutcomeText({ kind: "refused", refusal: { kind: "archived" } })).toBe(refusalText({ kind: "archived" }));
    expect(intentOutcomeText({ kind: "unanswered", reply: { kind: "unknown" } })).toBe(noAnswerText({ kind: "unknown" }));
  });

  it("say each standing fact in its own notice, and that a restart is what brings work back", () => {
    const standings: Standing[] = ["viewOnly", "sessionsDown", "stopped"];
    const notices = standings.map(standingNotice);
    expect(new Set(notices.map((notice) => notice.title)).size).toBe(standings.length);
    expect(new Set(notices.map((notice) => notice.body)).size).toBe(standings.length);
    expect(standingNotice("sessionsDown").body).toContain("until KeepDeck restarts");
    expect(standingNotice("stopped").body).toContain("until KeepDeck restarts");
    expect(standingNotice("viewOnly").body).toContain("only shows");
  });
});
