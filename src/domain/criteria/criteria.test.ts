import { describe, expect, it } from "vitest";
import { all, any, criterion, not } from "./criteria";

const hasA = criterion<{ a: boolean }>("has-a", ({ a }) => a);
const hasB = criterion<{ b: boolean }>("has-b", ({ b }) => b);

describe("criterion composition", () => {
  it("all is satisfied only when every member is", () => {
    const both = all<{ a: boolean; b: boolean }>("both", hasA, hasB);
    expect(both.satisfiedBy({ a: true, b: true })).toBe(true);
    expect(both.satisfiedBy({ a: true, b: false })).toBe(false);
    expect(both.satisfiedBy({ a: false, b: true })).toBe(false);
  });

  it("members read only what they declare — narrow criteria compose into richer contexts", () => {
    // hasA is a Criterion<{a}>; it slots into an {a, b} rule structurally.
    const rule = all<{ a: boolean; b: boolean }>("mixed", hasA);
    expect(rule.satisfiedBy({ a: true, b: false })).toBe(true);
  });

  it("any needs at least one satisfied member", () => {
    const either = any<{ a: boolean; b: boolean }>("either", hasA, hasB);
    expect(either.satisfiedBy({ a: false, b: true })).toBe(true);
    expect(either.satisfiedBy({ a: false, b: false })).toBe(false);
  });

  it("not negates its member and keeps a name of its own", () => {
    const noA = not("no-a", hasA);
    expect(noA.id).toBe("no-a");
    expect(noA.satisfiedBy({ a: false })).toBe(true);
    expect(noA.satisfiedBy({ a: true })).toBe(false);
  });

  it("an empty all is vacuously satisfied; an empty any never is", () => {
    expect(all("nothing").satisfiedBy({})).toBe(true);
    expect(any("nothing").satisfiedBy({})).toBe(false);
  });
});
