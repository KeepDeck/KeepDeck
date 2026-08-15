import { describe, expect, it } from "vitest";
import {
  defaultRoleFor,
  isLeadAddress,
  leadRole,
  mintRoleAddress,
  parseRoleAddress,
  roleAddress,
  roleById,
  teamRoles,
} from "./roles";

describe("the role catalog", () => {
  it("describes every role well enough to brief an agent with it", () => {
    // The catalog is the ONLY source of role text, so an entry missing a
    // charter would leave its holder with nothing said about it — which is
    // exactly the state this whole file exists to end.
    for (const role of teamRoles()) {
      expect(role.id, "id is an address, so it takes no spaces").not.toMatch(/\s/);
      expect(role.id).toBe(role.id.toLowerCase());
      expect(role.label.length, role.id).toBeGreaterThan(0);
      expect(role.summary.length, role.id).toBeGreaterThan(0);
      expect(role.charter.length, `${role.id} charter`).toBeGreaterThanOrEqual(3);
    }
  });

  it("has exactly one role that answers for a team, and it stands alone", () => {
    const lead = leadRole();
    expect(lead.repeatable, "two leads would be two answers to one question").toBe(
      false,
    );
    expect(teamRoles().filter((role) => !role.repeatable)).toEqual([lead]);
  });

  it("puts exactly one role in charge, and the built-in workers under it", () => {
    // The rules read standing, never the id — so the catalog must place
    // every role, and put exactly one in the leading position.
    expect(teamRoles().filter((role) => role.standing === "leads")).toEqual([
      leadRole(),
    ]);
    for (const id of ["impl", "reviewer", "tester"]) {
      expect(roleById(id)?.standing, id).toBe("reports");
    }
  });

  it("has no two roles under one name", () => {
    const ids = teamRoles().map((role) => role.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("answers to a name however it was typed, and refuses one it lacks", () => {
    expect(roleById("  LEAD ")).toBe(leadRole());
    expect(roleById("architect")).toBeUndefined();
    expect(roleById("")).toBeUndefined();
  });
});

describe("addresses", () => {
  const impl = roleById("impl")!;

  it("numbers a repeatable role and leaves a singleton alone", () => {
    expect(roleAddress(leadRole(), 1)).toBe("lead");
    expect(roleAddress(impl, 2)).toBe("impl-2");
  });

  it("reads a role back out of the address, which is all that is stored", () => {
    expect(parseRoleAddress("lead")).toEqual({ role: leadRole(), ordinal: 1 });
    expect(parseRoleAddress("impl-2")).toEqual({ role: impl, ordinal: 2 });
    expect(parseRoleAddress(" IMPL-2 ")).toEqual({ role: impl, ordinal: 2 });
  });

  it("refuses an address the catalog cannot account for", () => {
    // A role that was removed, or a name typed before the catalog existed.
    expect(parseRoleAddress("architect-1")).toBeNull();
    expect(parseRoleAddress("impl-")).toBeNull();
    expect(parseRoleAddress("")).toBeNull();
    // A singleton takes no number: `lead-2` is not a second lead, it is
    // nothing, and reading it as one would put two answers on a team.
    expect(parseRoleAddress("lead-2")).toBeNull();
    // And a repeatable role always carries one. `reviewer` as a synonym for
    // `reviewer-1` would give one member two spellings, and addressing
    // compares strings — a teammate told the other one writes to nobody.
    expect(parseRoleAddress("impl")).toBeNull();
  });

  it("only counts a TRAILING number, so a role id may hold a dash of its own", () => {
    // The catalog has none today; a custom `code-reviewer` will, and the
    // parse must not split it into `code` holding `reviewer-2`.
    expect(parseRoleAddress("impl-2-3")).toBeNull();
  });
});

describe("mintRoleAddress", () => {
  const impl = roleById("impl")!;

  it("takes the first free number, not the next one after the highest", () => {
    // impl-1 left; the team is impl-2 alone. Reusing the gap keeps the
    // addresses a person reads short and predictable.
    expect(mintRoleAddress(impl, ["impl-2"])).toBe("impl-1");
    expect(mintRoleAddress(impl, ["impl-1", "impl-2"])).toBe("impl-3");
    expect(mintRoleAddress(impl, [])).toBe("impl-1");
  });

  it("ignores case and stray spacing in what is already held", () => {
    expect(mintRoleAddress(impl, [" IMPL-1 "])).toBe("impl-2");
  });

  it("refuses a second holder of a singleton rather than minting lead-2", () => {
    expect(mintRoleAddress(leadRole(), [])).toBe("lead");
    expect(mintRoleAddress(leadRole(), ["lead"])).toBeNull();
  });
});

describe("defaultRoleFor", () => {
  it("fills the lead first, then a repeatable role", () => {
    // A team needs exactly one lead and it is the first thing anybody fills;
    // after that, more of the same singleton would only be refused.
    expect(defaultRoleFor([])).toBe(leadRole());
    const second = defaultRoleFor(["lead"]);
    expect(second).not.toBe(leadRole());
    expect(second.repeatable).toBe(true);
    // And it keeps answering that way however full the roster gets.
    expect(defaultRoleFor(["lead", "impl-1", "impl-2"]).repeatable).toBe(true);
  });
});

describe("isLeadAddress", () => {
  it("answers for the address alone, so no rule has to spell the name", () => {
    expect(isLeadAddress("lead")).toBe(true);
    expect(isLeadAddress("impl-1")).toBe(false);
    expect(isLeadAddress("architect")).toBe(false);
    expect(isLeadAddress(undefined)).toBe(false);
  });
});
