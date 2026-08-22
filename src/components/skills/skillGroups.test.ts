import { describe, expect, it } from "vitest";
import type { LibrarySkill } from "../../app/skillsLibrary";
import { buildSkillGroups, labelForScope } from "./skillGroups";

const skill = (
  name: string,
  scope: LibrarySkill["scope"] = { kind: "global" },
): LibrarySkill => ({ scope, name, content: `body of ${name}` });

const ws = (wsId: string): LibrarySkill["scope"] => ({
  kind: "workspace",
  wsId,
});

describe("buildSkillGroups", () => {
  it("always offers Global, even with nothing in it", () => {
    const groups = buildSkillGroups([], null);
    expect(groups.map((g) => g.label)).toEqual(["Global"]);
    expect(groups[0].items).toEqual([]);
  });

  it("reads an unread library as empty, not as an error", () => {
    // `null` is "the read has not landed"; the nav says what that means
    // through its own emptyMeans prop, so the groups themselves are
    // simply empty rather than absent.
    expect(buildSkillGroups(null, null).map((g) => g.label)).toEqual(["Global"]);
  });

  it("adds the ACTIVE workspace only, and files its rows under it", () => {
    const mine = skill("deploy", ws("ws-1"));
    const other = skill("stale", ws("ws-2"));
    const groups = buildSkillGroups([skill("global-one"), mine, other], {
      id: "ws-1",
      name: "KeepDeck",
    });
    expect(groups.map((g) => g.label)).toEqual(["Global", "KeepDeck"]);
    expect(groups[1].items).toEqual([mine]);
    // Another workspace's skill belongs to no group on screen — it is not
    // silently swept into the active one.
    expect(groups.flatMap((g) => g.items)).not.toContain(other);
  });

  it("puts Bundled LAST — user content outranks app content", () => {
    const groups = buildSkillGroups(
      [skill("artifacts", { kind: "bundled" }), skill("artifacts")],
      { id: "ws-1", name: "KeepDeck" },
    );
    expect(groups.map((g) => g.label)).toEqual([
      "Global",
      "KeepDeck",
      "Bundled",
    ]);
  });

  it("shows a user skill and its bundled namesake side by side", () => {
    // Namespaces at rest: resolution-by-name happens in staging, not
    // here, so both rows are visible and neither hides the other.
    const groups = buildSkillGroups(
      [skill("artifacts"), skill("artifacts", { kind: "bundled" })],
      null,
    );
    expect(groups.find((g) => g.label === "Global")!.items).toHaveLength(1);
    expect(groups.find((g) => g.label === "Bundled")!.items).toHaveLength(1);
  });

  it("omits the Bundled group entirely when the tier ships nothing", () => {
    // An empty heading would advertise a tier the build does not have.
    expect(
      buildSkillGroups([skill("mine")], null).map((g) => g.label),
    ).toEqual(["Global"]);
  });
});

describe("labelForScope", () => {
  const groups = buildSkillGroups([], { id: "ws-1", name: "KeepDeck" });

  it("names a scope from its own group", () => {
    expect(labelForScope(groups, { kind: "global" })).toBe("Global");
    expect(labelForScope(groups, { kind: "workspace", wsId: "ws-1" })).toBe(
      "KeepDeck",
    );
  });

  it("does NOT stamp the active workspace's name on a foreign scope", () => {
    // The editor can outlive the switch that changed workspaces, and this
    // chip is the only thing on screen saying which library a save lands
    // in — answering "KeepDeck" for ws-2 would name the wrong library.
    expect(labelForScope(groups, { kind: "workspace", wsId: "ws-2" })).toBe(
      "Workspace",
    );
  });
});
