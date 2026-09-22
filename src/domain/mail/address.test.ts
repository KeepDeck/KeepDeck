import { describe, expect, it } from "vitest";
import { formatAddress, parseAddress } from "./address";

describe("mail address grammar", () => {
  it("writes the team's id, never its name, and reads back what it wrote", () => {
    // A name changes on a rename; the id is what a reply can rely on.
    const web = { id: "team-3f9a1c20", name: "web" };
    expect(formatAddress("impl-1", web)).toBe("impl-1@team-3f9a1c20");
    expect(parseAddress(formatAddress("impl-1", web))).toEqual({ role: "impl-1", team: "team-3f9a1c20" });
  });

  it("splits at the FIRST @, so a team name typed there may carry one of its own", () => {
    // A role id never holds an @ — the catalog admits [a-z][a-z0-9-]* —
    // so everything after the first one is the team.
    expect(parseAddress("lead@ops@night")).toEqual({ role: "lead", team: "ops@night" });
  });

  it("is not an address without both halves", () => {
    expect(parseAddress("impl-1")).toBeNull();
    expect(parseAddress("@web")).toBeNull();
    expect(parseAddress("lead@")).toBeNull();
    expect(parseAddress(" @ ")).toBeNull();
  });

  it("trims the halves the way every name is compared", () => {
    expect(parseAddress(" lead @ Web ")).toEqual({ role: "lead", team: "Web" });
  });
});
