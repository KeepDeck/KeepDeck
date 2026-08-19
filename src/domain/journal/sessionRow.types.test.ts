import { describe, expect, it } from "vitest";

// COMPILER GUARDS for the row union. Each pair = one FORBIDDEN literal
// (carrying @ts-expect-error — an ASSERTION that this must NOT compile,
// not a suppression of a nuisance) + one CONTROL literal: the same
// object WITHOUT the forbidden field, which MUST compile cleanly with
// no directive. The pair tells the forbidden COMBINATION from a typo in
// a field name — a bare directive catches anything.
//
// Why these bite: the bases are annotated as their VARIANTS (not
// `satisfies Record<string, unknown>` — that widened `kind` to string
// and made every directive permanently "used" by an unrelated error,
// killing all seven guards at once) and carry no `as` casts (a cast
// compiles anything and would mute the control's own proof). On this
// honest shape, the forbidden literal is exactly one excess/missing
// property away from legal, and the directive has exactly that error to
// consume. Before the union existed, these literals compiled — the
// directives were UNUSED and tsc failed on TS2578; weaken the type back
// and they redden the same way.
//
// G7's honesty note: excess-property checking fires on LITERALS only;
// an object assembled through a variable slips past it. So G7 proves
// "one cannot WRITE this as a literal", not "one cannot obtain it any
// way at all".
import type { BoundSessionRow, IndexSessionRow } from "./sessionRow";

/** A legal BOUND row, annotated AS the variant — the compiler checks
 * every field against the real type; nothing is cast into place. */
const boundBase: BoundSessionRow = {
  kind: "bound",
  agent: "claude",
  sessionId: "s-1",
  cwd: "/repo",
  title: "t",
  read: { reference: "/j/s-1" },
  readLinks: ["/j/s-1"],
  branch: "kd/ws/1",
  liveness: "closed",
  status: null,
  when: 100,
  handle: {
    agent: "claude",
    sessionId: "s-1",
    cwd: "/repo",
  },
};

/** A legal INDEX row, same honesty. */
const indexBase: IndexSessionRow = {
  kind: "index",
  agent: "claude",
  sessionId: "s-1",
  cwd: "/repo",
  title: "t",
  read: { reference: "/store/s-1" },
  readLinks: ["/store/s-1"],
  when: 100,
  snippet: null,
  handle: {
    agent: "claude",
    sessionId: "s-1",
    cwd: "/repo",
  },
};

describe("UnifiedSessionRow union — compiler guards", () => {
  it("G2: a BOUND row cannot carry UNKNOWN liveness — the dot is a bound fact, always known", () => {
    // CONTROL: the bound base (liveness closed) compiles cleanly.
    expect(boundBase.liveness).toBe("closed");
    // FORBIDDEN: null liveness on a bound row must not typecheck.
    // @ts-expect-error — ASSERTION: a bound row's liveness is "live" | "closed";
    // null was the FLAT type's absence — the union has no such state here.
    const forbidden: BoundSessionRow = { ...boundBase, liveness: null };
    expect(forbidden).toBeDefined();
  });

  it("G3: an INDEX row cannot carry a branch", () => {
    // CONTROL: the index base compiles cleanly, no branch in sight.
    expect(indexBase.read.reference).toBe("/store/s-1");
    // @ts-expect-error — ASSERTION: branch does not exist on an index row.
    const forbidden: IndexSessionRow = { ...indexBase, branch: "kd/ws/1" };
    expect(forbidden).toBeDefined();
  });

  it("G4: an INDEX row cannot carry liveness", () => {
    expect(indexBase.when).toBe(100);
    // @ts-expect-error — ASSERTION: liveness does not exist on an index row.
    const forbidden: IndexSessionRow = { ...indexBase, liveness: "closed" };
    expect(forbidden).toBeDefined();
  });

  it("G5: a BOUND row cannot carry a snippet", () => {
    expect(boundBase.branch).toBe("kd/ws/1");
    // @ts-expect-error — ASSERTION: snippet does not exist on a bound row.
    const forbidden: BoundSessionRow = { ...boundBase, snippet: "match" };
    expect(forbidden).toBeDefined();
  });

  it("G7: a row cannot be written as a literal carrying BOTH sources' fields", () => {
    expect(boundBase.handle.sessionId).toBe("s-1");
    // A WHOLE literal (no spread — excess-property checking fires on
    // literals only; see the header note): a bound row's fields plus the
    // other source's snippet. The directive sits ON the forbidden field,
    // where the excess-property error lands.
    const forbidden: BoundSessionRow = {
      kind: "bound",
      agent: "claude",
      sessionId: "s-1",
      cwd: "/repo",
      title: "t",
      read: { reference: "/j/s-1" },
      readLinks: ["/j/s-1"],
      branch: "kd/ws/1",
      liveness: "closed",
      status: null,
      when: 100,
      handle: { agent: "claude", sessionId: "s-1", cwd: "/repo" },
      // @ts-expect-error — ASSERTION: excess-property check — snippet is
      // the other source's field; a bound literal must not carry it.
      snippet: "match",
    };
    expect(forbidden).toBeDefined();
  });

  it("G8: an INDEX row cannot carry a status", () => {
    expect(indexBase.snippet).toBeNull();
    // @ts-expect-error — ASSERTION: status does not exist on an index row.
    const forbidden: IndexSessionRow = { ...indexBase, status: "indexing" };
    expect(forbidden).toBeDefined();
  });

  it("G9: an INDEX row cannot have a NULL read — it was found BY the link", () => {
    expect(indexBase.read.reference).toBe("/store/s-1");
    // @ts-expect-error — ASSERTION: read on an index row is never null.
    const forbidden: IndexSessionRow = { ...indexBase, read: null };
    expect(forbidden).toBeDefined();
  });
});
