import { describe, expect, it } from "vitest";
import { libraryVerdicts, type LibraryVerdictInput, type NameProblem } from "./libraryVerdicts";

type Scope = "lib";
interface Row {
  scope: Scope;
  name: string;
}
interface Form {
  name: string;
}

const rowAt = (rows: Row[] | null, scope: Scope, name: string) =>
  (rows ?? []).find((r) => r.scope === scope && r.name === name);
const nameProblemOf = (name: string): NameProblem =>
  name === "" ? "empty" : /^[a-z-]+$/.test(name) ? null : "invalid";

const verdicts = (over: Partial<LibraryVerdictInput<Scope, Row, Form>> = {}) =>
  libraryVerdicts<Scope, Row, Form>({
    selection: { mode: "edit", scope: "lib", name: "review" },
    form: { name: "review" },
    rows: [{ scope: "lib", name: "review" }, { scope: "lib", name: "deploy" }],
    listTrusted: true,
    busy: false,
    dirty: false,
    nameTouched: false,
    rowAt,
    nameProblemOf,
    ...over,
  });

describe("the verdicts every library editor shares", () => {
  it("sees the open item vanish — but not while a write is in flight, nor over an untrusted list", () => {
    const gone = { rows: [{ scope: "lib" as const, name: "deploy" }] };
    expect(verdicts(gone).vanished).toBe(true);
    // A rename re-anchors the selection to a name the list does not hold
    // yet; the save that follows owns the re-read.
    expect(verdicts({ ...gone, busy: true }).vanished).toBe(false);
    // Absence from a list whose last read failed proves nothing.
    expect(verdicts({ ...gone, listTrusted: false }).vanished).toBe(false);
    expect(verdicts({ ...gone, rows: null }).vanished).toBe(false);
    expect(verdicts({ ...gone, selection: { mode: "create", scope: "lib" } }).vanished).toBe(false);
  });

  it("calls a name taken only when ANOTHER item holds it", () => {
    expect(verdicts({ form: { name: "deploy" } }).nameTaken).toBe(true);
    // Keeping your own name is not a collision.
    expect(verdicts().nameTaken).toBe(false);
    expect(
      verdicts({ selection: { mode: "create", scope: "lib" }, form: { name: "review" } }).nameTaken,
    ).toBe(true);
    // A view row never authors anything, so no name is judged.
    expect(verdicts({ selection: { mode: "view", name: "x" }, form: { name: "deploy" } }).nameTaken).toBe(
      false,
    );
  });

  it("judges a name only where it is being AUTHORED — an inherited one stays editable", () => {
    // An edit keeping its (hand-made, would-be-refused) name: not judged.
    expect(verdicts({ form: { name: "review" }, selection: { mode: "edit", scope: "lib", name: "review" } }).nameProblem).toBeNull();
    expect(verdicts({ selection: { mode: "create", scope: "lib" }, form: { name: "Bad Name" } })).toMatchObject({
      authoringName: true,
      nameProblem: "invalid",
    });
    expect(verdicts({ form: { name: "Bad Name" } })).toMatchObject({ authoringName: true, nameProblem: "invalid" });
    expect(verdicts({ selection: { mode: "view", name: "x" }, form: { name: "" } }).authoringName).toBe(false);
  });

  it("holds the name message back until the user has started, while the gate sees it at once", () => {
    const pristine = verdicts({ selection: { mode: "create", scope: "lib" }, form: { name: "" } });
    expect(pristine.nameProblem).toBe("empty");
    expect(pristine.shownNameProblem).toBeNull();
    for (const started of [{ nameTouched: true }, { dirty: true }]) {
      expect(
        verdicts({ selection: { mode: "create", scope: "lib" }, form: { name: "" }, ...started }).shownNameProblem,
      ).toBe("empty");
    }
    // A non-empty name is itself a start.
    expect(verdicts({ selection: { mode: "create", scope: "lib" }, form: { name: "Bad" } }).shownNameProblem).toBe(
      "invalid",
    );
  });

  it("notices a retitle — the hatch that turns a vanished draft's save into a create", () => {
    expect(verdicts({ form: { name: "review-2" } }).retitled).toBe(true);
    expect(verdicts().retitled).toBe(false);
    expect(verdicts({ selection: { mode: "create", scope: "lib" }, form: { name: "x" } }).retitled).toBe(false);
  });
});
