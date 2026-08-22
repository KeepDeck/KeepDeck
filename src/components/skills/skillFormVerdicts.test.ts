import { describe, expect, it } from "vitest";
import type { LibrarySkill } from "../../app/skillsLibrary";
import type { SkillDraft } from "../../domain/skills";
import {
  skillFormVerdicts,
  type Selection,
  type VerdictInput,
  type WritableSelection,
} from "./skillFormVerdicts";

const skill = (
  name: string,
  scope: LibrarySkill["scope"] = { kind: "global" },
): LibrarySkill => ({ scope, name, content: `body of ${name}` });

const draft = (over: Partial<SkillDraft> = {}): SkillDraft => ({
  name: "deploy",
  description: "About deploy",
  body: "Body",
  extraFrontmatter: [],
  ...over,
});

const global: Selection = { mode: "edit", scope: { kind: "global" }, name: "deploy" };

const verdicts = (over: Partial<VerdictInput> = {}) =>
  skillFormVerdicts({
    selection: global,
    form: draft(),
    skills: [skill("deploy")],
    listTrusted: true,
    busy: false,
    dirty: true,
    nameTouched: false,
    ...over,
  });

describe("the family is decided together", () => {
  it("hands out ONE frozen object — nobody amends a verdict in passing", () => {
    const v = verdicts();
    expect(Object.isFrozen(v)).toBe(true);
  });
});

describe("vanished", () => {
  it("is true when the open skill left the library", () => {
    expect(verdicts({ skills: [] }).vanished).toBe(true);
  });

  it("is FALSE while one of our own writes is in flight", () => {
    // A rename re-anchors the selection to a name the list does not hold
    // yet — the save that follows owns the re-read. Judging it mid-submit
    // calls every rename a disappearance and disables the save that would
    // complete it.
    expect(verdicts({ skills: [], busy: true }).vanished).toBe(false);
  });

  it("is FALSE over a list whose last read failed — absence proves nothing", () => {
    expect(verdicts({ skills: [], listTrusted: false }).vanished).toBe(false);
  });

  it("is FALSE before any read has landed", () => {
    expect(verdicts({ skills: null }).vanished).toBe(false);
  });

  it("kills Save — the gate and the write machine refuse as one", () => {
    // Refusing here is the whole protection: the write machine reads THIS
    // verdict rather than forming its own, so there is no path where the
    // button says impossible and a doomed update goes through anyway.
    // The user's text stays on screen regardless — throwing away what
    // they typed is the one thing worse than a stale editor.
    const gone = verdicts({ skills: [] });
    expect(gone.vanished).toBe(true);
    expect(gone.canSave).toBe(false);
  });
});

describe("the name is judged only where it is AUTHORED", () => {
  it("leaves an INHERITED name alone, however this build would spell it", () => {
    // A hand-made `My_Skill` the Rust side stores and lists happily must
    // stay editable — judging it here made it openable and unsavable,
    // with a complaint under a name the user was not editing.
    const inherited: Selection = {
      mode: "edit",
      scope: { kind: "global" },
      name: "My_Skill",
    };
    const v = verdicts({
      selection: inherited,
      form: draft({ name: "My_Skill" }),
      skills: [skill("My_Skill")],
    });
    expect(v.authoringName).toBe(false);
    expect(v.nameProblem).toBeNull();
    expect(v.canSave).toBe(true);
  });

  it("still refuses a name the user is CHANGING to something invalid", () => {
    const v = verdicts({ form: draft({ name: "My_Skill" }) });
    expect(v.authoringName).toBe(true);
    expect(v.nameProblem).toBe("invalid");
    expect(v.canSave).toBe(false);
  });
});

describe("one verdict, two renderings — the gate and the message", () => {
  // Derived separately these drifted: an emptied Name field disabled Save
  // while the message stayed hidden, because "empty" counted as invalid
  // at the gate and as "nothing typed yet" at the message.
  it("a pristine create form says nothing, and offers nothing", () => {
    const v = verdicts({
      selection: { mode: "create", scope: { kind: "global" } },
      form: draft({ name: "", description: "" }),
      dirty: false,
      nameTouched: false,
    });
    expect(v.nameProblem).toBe("empty");
    expect(v.shownNameProblem).toBeNull();
    expect(v.canSave).toBe(false);
  });

  it("once the user has STARTED anywhere, the emptied name explains itself", () => {
    // Not "touched THIS field": filling the description first is the
    // natural order on a create form, and it used to leave Create dead
    // with nothing on screen.
    const v = verdicts({
      selection: { mode: "create", scope: { kind: "global" } },
      form: draft({ name: "" }),
      dirty: true,
    });
    expect(v.shownNameProblem).toBe("empty");
    expect(v.shownNameProblem).toBe(v.nameProblem);
  });
});

describe("nameTaken", () => {
  it("keeping your OWN name is not a collision", () => {
    expect(verdicts().nameTaken).toBe(false);
  });

  it("renaming onto a sibling in the same scope is", () => {
    const v = verdicts({
      form: draft({ name: "other" }),
      skills: [skill("deploy"), skill("other")],
    });
    expect(v.nameTaken).toBe(true);
    expect(v.canSave).toBe(false);
  });

  it("a same NAME in another scope is not a collision", () => {
    const v = verdicts({
      form: draft({ name: "other" }),
      skills: [skill("deploy"), skill("other", { kind: "workspace", wsId: "ws-1" })],
    });
    expect(v.nameTaken).toBe(false);
  });
});

describe("the read-only tier authors nothing", () => {
  const view: Selection = { mode: "view", name: "artifacts" };

  it("judges no name and offers no save for a bundled row", () => {
    const v = verdicts({
      selection: view,
      form: draft({ name: "artifacts" }),
      skills: [skill("artifacts", { kind: "bundled" }), skill("artifacts")],
    });
    expect(v.isView).toBe(true);
    expect(v.authoringName).toBe(false);
    expect(v.nameTaken).toBe(false);
    expect(v.nameProblem).toBeNull();
    expect(v.canSave).toBe(false);
  });

  it("does not call a bundled row vanished — it is not an edit at all", () => {
    expect(verdicts({ selection: view, skills: [] }).vanished).toBe(false);
  });
});

describe("nothing selected", () => {
  it("offers no save and judges no name", () => {
    const v = verdicts({ selection: null, form: draft({ name: "" }) });
    expect(v.canSave).toBe(false);
    expect(v.authoringName).toBe(false);
    expect(v.vanished).toBe(false);
  });
});

describe("the description rule", () => {
  it("refuses an empty one — some CLIs silently drop such a skill", () => {
    const v = verdicts({ form: draft({ description: "  " }) });
    expect(v.descriptionProblem).toBe("empty");
    expect(v.canSave).toBe(false);
  });
});

describe("the write machine cannot be handed the read-only tier", () => {
  it("COMPILER GUARD: a view selection is not a writable one", () => {
    // The assertion is the directive, not the expect below: if this
    // literal ever compiles, the type stopped excluding the bundled tier
    // and the runtime guard that was deleted has to come back.
    // @ts-expect-error — a view selection has no scope and may not be written.
    const forbidden: WritableSelection = { mode: "view", name: "artifacts" };
    expect(forbidden).toBeDefined();
  });

  it("CONTROL: the same shape WITH a scope is writable, so the guard bites for the right reason", () => {
    const allowed: WritableSelection = {
      mode: "edit",
      scope: { kind: "global" },
      name: "artifacts",
    };
    expect(allowed.scope).toEqual({ kind: "global" });
  });
});
