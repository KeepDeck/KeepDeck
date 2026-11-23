import { describe, expect, it } from "vitest";
import { ownerRefusalOf, roleRefused, type OwnerRefusal } from "./ownerRefusals";

const EVERY: OwnerRefusal[] = [
  { kind: "gone", what: "workspace" },
  { kind: "unreadable", what: "team" },
  { kind: "notTaken", what: "move" },
  { kind: "teamFull" },
  { kind: "role", why: "misfit", role: "lead", open: ["impl-1"] },
  { kind: "role", why: "missing", role: "" },
  { kind: "sessionHeld" },
  { kind: "noBranch" },
  { kind: "wrongOwner", command: "addTeam" },
  { kind: "notAsked" },
  { kind: "failed" },
  { kind: "unknown" },
];

describe("ownerRefusalOf", () => {
  it("reads back every kind an owner gives, as the machine carried it", () => {
    for (const refusal of EVERY) {
      expect(ownerRefusalOf(JSON.parse(JSON.stringify(refusal)))).toEqual(refusal);
    }
  });

  it("reads anything else as unknown, never as a guess", () => {
    const malformed: unknown[] = [
      "the role lead is taken",
      null,
      42,
      {},
      { kind: "gone", what: "pane" },
      { kind: "notTaken", what: "workspace" },
      { kind: "role", why: "rude", role: "lead" },
      { kind: "role", why: "taken" },
      { kind: "role", why: "taken", role: "lead", open: "impl-1" },
      { kind: "role", why: "taken", role: "lead", open: [1] },
      { kind: "wrongOwner" },
      { kind: "someday" },
    ];
    for (const why of malformed) expect(ownerRefusalOf(why)).toEqual({ kind: "unknown" });
  });
});

describe("roleRefused", () => {
  it("carries the role rule's no whole: why, the role, and the roles still open", () => {
    expect(roleRefused({ ok: false, why: "taken", role: "lead", open: ["impl-1", "impl-2"] })).toEqual({
      kind: "role",
      why: "taken",
      role: "lead",
      open: ["impl-1", "impl-2"],
    });
  });
});
