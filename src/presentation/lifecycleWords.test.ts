import { describe, expect, it } from "vitest";
import type { NoAnswer, Refusal } from "../domain/lifecycle";
import { noAnswerText, refusalText } from "./lifecycleWords";

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
  { kind: "rejected", reason: "the role lead is taken" },
];
const silences: NoAnswer[] = [{ kind: "unavailable" }, { kind: "unknown" }];

describe("the lifecycle's words", () => {
  it("say each refusal kind in its own sentence, borrowed from no other", () => {
    const said = refusals.map(refusalText);
    expect(said.every((text) => text.trim().length > 0)).toBe(true);
    expect(new Set(said).size).toBe(said.length);
  });

  it("carry an owner's own refusal as it gave it", () => {
    expect(refusalText({ kind: "rejected", reason: "the role lead is taken" })).toBe("the role lead is taken");
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
});
