import { describe, expect, expectTypeOf, it } from "vitest";

// The concrete bases check each variant's required fields. The type-level
// assertions check forbidden fields and values without constructing invalid
// runtime rows or relying on a compiler-error directive.
import type { BoundSessionRow, IndexSessionRow, UnifiedSessionRow } from "./sessionRow";

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
    expect(boundBase.liveness).toBe("closed");
    expectTypeOf<BoundSessionRow["liveness"]>().toEqualTypeOf<"live" | "closed">();
  });

  it("G3: an INDEX row cannot carry a branch", () => {
    expect(indexBase.read.reference).toBe("/store/s-1");
    expectTypeOf<IndexSessionRow>().not.toHaveProperty("branch");
  });

  it("G4: an INDEX row cannot carry liveness", () => {
    expect(indexBase.when).toBe(100);
    expectTypeOf<IndexSessionRow>().not.toHaveProperty("liveness");
  });

  it("G5: a BOUND row cannot carry a snippet", () => {
    expect(boundBase.branch).toBe("kd/ws/1");
    expectTypeOf<BoundSessionRow>().not.toHaveProperty("snippet");
  });

  it("G7: narrowing the union to one source keeps the other source's field out", () => {
    expect(boundBase.handle.sessionId).toBe("s-1");
    expectTypeOf<Extract<UnifiedSessionRow, { kind: "bound" }>>().not.toHaveProperty("snippet");
    expectTypeOf<Extract<UnifiedSessionRow, { kind: "index" }>>().toHaveProperty("snippet");
  });

  it("G8: an INDEX row cannot carry a status", () => {
    expect(indexBase.snippet).toBeNull();
    expectTypeOf<IndexSessionRow>().not.toHaveProperty("status");
  });

  it("G9: an INDEX row cannot have a NULL read — it was found BY the link", () => {
    expect(indexBase.read.reference).toBe("/store/s-1");
    expectTypeOf<null>().not.toExtend<IndexSessionRow["read"]>();
  });
});
