import { afterEach, describe, expect, it } from "vitest";
import { mergeRoleCatalog, roleIdProblem } from "./catalog";
import {
  builtInRoles,
  configureRoleCatalog,
  leadRole,
  parseRoleAddress,
  roleById,
  teamRoles,
} from "./roles";

afterEach(() => configureRoleCatalog(null));

const stored = (entries: Record<string, unknown>) => new Map(Object.entries(entries));

/** A record that means something, to mutate per case. */
const docs = () => ({
  label: "Docs",
  summary: "writes down what the team built",
  charter: ["You DOCUMENT. Write down what was built and why."],
});

describe("mergeRoleCatalog", () => {
  it("answers with the built-ins untouched when nothing is stored", () => {
    const { roles, problems } = mergeRoleCatalog(stored({}));
    expect(roles).toEqual(builtInRoles());
    expect(problems).toEqual([]);
  });

  it("edits a built-in's texts and nothing else", () => {
    // A record naming a built-in is an edit of what the role SAYS. What it
    // IS — standing, repeatability — stays the deck's, because the rules
    // run on those.
    const { roles, problems } = mergeRoleCatalog(
      stored({
        lead: {
          label: "Architect",
          summary: "owns the plan",
          charter: ["You run this team the architect's way."],
        },
      }),
    );
    const lead = roles.find((role) => role.id === "lead")!;
    expect(lead.label).toBe("Architect");
    expect(lead.charter).toEqual(["You run this team the architect's way."]);
    expect(lead.standing).toBe("leads");
    expect(lead.repeatable).toBe(false);
    expect(problems).toEqual([]);
  });

  it("applies a built-in's texts but not a hand-edited change of semantics", () => {
    // The form never offers these fields for a built-in, so only a hand
    // edit lands here — and it is told what happened rather than shrugged
    // at.
    const { roles, problems } = mergeRoleCatalog(
      stored({ impl: { ...docs(), standing: "peer" } }),
    );
    const impl = roles.find((role) => role.id === "impl")!;
    expect(impl.label).toBe("Docs");
    expect(impl.standing).toBe("reports");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("impl");
  });

  it("keeps a built-in's text edit even when the record restates its own standing", () => {
    // A faithful hand copy of `"standing": "leads"` beside new texts must
    // lose the semantics, never the texts it rode in with.
    const { roles, problems } = mergeRoleCatalog(
      stored({ lead: { ...docs(), label: "Captain", standing: "leads" } }),
    );
    const lead = roles.find((role) => role.id === "lead")!;
    expect(lead.label).toBe("Captain");
    expect(lead.standing).toBe("leads");
    expect(problems).toHaveLength(1);
  });

  it("adds a role of the user's own — a repeatable working role by default", () => {
    const { roles, problems } = mergeRoleCatalog(stored({ docs: docs() }));
    const role = roles.find((candidate) => candidate.id === "docs")!;
    expect(role.repeatable).toBe(true);
    expect(role.standing).toBe("reports");
    expect(problems).toEqual([]);
  });

  it("takes an explicit peer standing, and refuses a leading one", () => {
    const peer = mergeRoleCatalog(stored({ buddy: { ...docs(), standing: "peer" } }));
    expect(peer.roles.find((role) => role.id === "buddy")?.standing).toBe("peer");
    // A second leading role would put two answers on "who runs a team" —
    // decided against; the lead's TEXTS are editable instead.
    const boss = mergeRoleCatalog(stored({ boss: { ...docs(), standing: "leads" } }));
    expect(boss.roles.find((role) => role.id === "boss")).toBeUndefined();
    expect(boss.problems[0]).toContain("boss");
  });

  it("drops a record that means nothing, names why, and keeps the rest whole", () => {
    // A typo in one file must not take the catalog down with it: the good
    // record lands, the bad one is refused in words its author can act on.
    const { roles, problems } = mergeRoleCatalog(
      stored({
        docs: docs(),
        broken: { label: "", summary: "x", charter: [] },
        noise: "not even an object",
      }),
    );
    expect(roles.find((role) => role.id === "docs")).toBeDefined();
    expect(roles.find((role) => role.id === "broken")).toBeUndefined();
    expect(roles.filter((role) => builtInRoles().includes(role))).toHaveLength(
      builtInRoles().length,
    );
    expect(problems).toHaveLength(2);
  });

  it("refuses an id that cannot be an address", () => {
    const { roles, problems } = mergeRoleCatalog(
      stored({ "impl-2": docs(), "Docs!": docs() }),
    );
    expect(roles).toEqual(builtInRoles());
    expect(problems).toHaveLength(2);
  });

  it("folds two spellings of one id into the first", () => {
    // Addressing compares lowercased strings, so two spellings would be
    // one address with two contenders for its texts.
    const { roles, problems } = mergeRoleCatalog(
      stored({ docs: docs(), " DOCS ": { ...docs(), label: "Shadow" } }),
    );
    expect(roles.find((role) => role.id === "docs")?.label).toBe("Docs");
    expect(problems).toHaveLength(1);
  });
});

describe("roleIdProblem", () => {
  it("holds the address grammar the merge and the form share", () => {
    expect(roleIdProblem("docs")).toBeNull();
    expect(roleIdProblem("code-reviewer")).toBeNull();
    // The numbered tail is how HOLDERS are told apart: a role named like
    // one would be indistinguishable from the second holder of another.
    expect(roleIdProblem("impl-2")).not.toBeNull();
    expect(roleIdProblem("Docs")).not.toBeNull();
    expect(roleIdProblem("with space")).not.toBeNull();
    expect(roleIdProblem("")).not.toBeNull();
    expect(roleIdProblem("x".repeat(25))).not.toBeNull();
  });
});

describe("configureRoleCatalog", () => {
  it("is what every consumer reads, addresses included", () => {
    // The whole point of the seam: install a merged catalog and the rules,
    // the addresses and the accessors follow without any caller changing.
    const merged = mergeRoleCatalog(stored({ docs: docs() }));
    configureRoleCatalog(merged.roles);
    expect(roleById("docs")).toBeDefined();
    expect(parseRoleAddress("docs-2")?.role.id).toBe("docs");
    expect(leadRole().standing).toBe("leads");
  });

  it("resets to the built-ins with null", () => {
    configureRoleCatalog(mergeRoleCatalog(stored({ docs: docs() })).roles);
    configureRoleCatalog(null);
    expect(teamRoles()).toEqual(builtInRoles());
  });
});
