import { describe, expect, it } from "vitest";

// COMPILER GUARDS for the row union. Each pair = one FORBIDDEN literal
// (carrying @ts-expect-error — an ASSERTION that this must NOT compile,
// not a suppression of a nuisance) + one CONTROL literal: the same
// object WITHOUT the forbidden field, which MUST compile cleanly with
// no directive. The pair tells the forbidden COMBINATION from a typo in
// a field name — a bare directive catches anything.
//
// Why these are red BEFORE the union and green after: before, the
// forbidden literal compiles fine, so the unused directive itself fails
// the typecheck ("Unused '@ts-expect-error' directive"). After, the
// directive is used exactly once. Weaken the type back — red again.
//
// З7's honesty note: excess-property checking fires on LITERALS only;
// an object assembled through a variable slips past it. So З7 proves
// "one cannot WRITE this as a literal", not "one cannot obtain it any
// way at all".
import type { BoundSessionRow, IndexSessionRow } from "./sessionRow";

const boundBase = {
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
} satisfies Record<string, unknown>;

const indexBase = {
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
} satisfies Record<string, unknown>;

describe("UnifiedSessionRow union — compiler guards", () => {
  it("З2: a BOUND row cannot carry the liveness absence — the dot is a bound fact, always known", () => {
    // CONTROL: the bound base (with liveness) compiles cleanly.
    const control: BoundSessionRow = { ...boundBase } as BoundSessionRow;
    expect(control.kind).toBe("bound");
    // FORBIDDEN: dropping liveness must not typecheck.
    // @ts-expect-error — ASSERTION: liveness is required on a bound row.
    const forbidden: BoundSessionRow = { ...boundBase, liveness: undefined };
    expect(forbidden).toBeDefined();
  });

  it("З3: an INDEX row cannot carry a branch", () => {
    const control: IndexSessionRow = { ...indexBase } as IndexSessionRow;
    expect(control.kind).toBe("index");
    // @ts-expect-error — ASSERTION: branch does not exist on an index row.
    const forbidden: IndexSessionRow = { ...indexBase, branch: "kd/ws/1" };
    expect(forbidden).toBeDefined();
  });

  it("З4: an INDEX row cannot carry liveness", () => {
    const control: IndexSessionRow = { ...indexBase } as IndexSessionRow;
    expect(control.read.reference).toBe("/store/s-1");
    // @ts-expect-error — ASSERTION: liveness does not exist on an index row.
    const forbidden: IndexSessionRow = { ...indexBase, liveness: "closed" };
    expect(forbidden).toBeDefined();
  });

  it("З5: a BOUND row cannot carry a snippet", () => {
    const control: BoundSessionRow = { ...boundBase } as BoundSessionRow;
    expect(control.branch).toBe("kd/ws/1");
    // @ts-expect-error — ASSERTION: snippet does not exist on a bound row.
    const forbidden: BoundSessionRow = { ...boundBase, snippet: "match" };
    expect(forbidden).toBeDefined();
  });

  it("З7: a row cannot be written as a literal carrying BOTH sources' fields", () => {
    const control: BoundSessionRow = { ...boundBase } as BoundSessionRow;
    expect(control.handle.sessionId).toBe("s-1");
    // A WHOLE literal (no spread — excess-property checking fires on
    // literals only; see the header note): a bound row's fields plus the
    // other source's snippet. The directive sits ON the object literal's
    // opening — it governs the whole literal, where the excess-property
    // error lands.
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

  it("З8: an INDEX row cannot carry a status", () => {
    const control: IndexSessionRow = { ...indexBase } as IndexSessionRow;
    expect(control.snippet).toBeNull();
    // @ts-expect-error — ASSERTION: status does not exist on an index row.
    const forbidden: IndexSessionRow = { ...indexBase, status: "indexing" };
    expect(forbidden).toBeDefined();
  });

  it("З9: an INDEX row cannot have a NULL read — it was found BY the link", () => {
    const control: IndexSessionRow = { ...indexBase } as IndexSessionRow;
    expect(control.when).toBe(100);
    // @ts-expect-error — ASSERTION: read on an index row is never null.
    const forbidden: IndexSessionRow = { ...indexBase, read: null };
    expect(forbidden).toBeDefined();
  });
});
