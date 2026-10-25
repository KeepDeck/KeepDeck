// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  booleanOf,
  elementOf,
  elementsOf,
  instanceOf,
  listOf,
  maybeRecord,
  numberOf,
  recordOf,
  recordsOf,
  sessionIds,
  statusEdge,
  stringOf,
  usageResult,
} from "./values.test-support";

describe("recordOf / maybeRecord", () => {
  it("returns a record and names a non-record", () => {
    expect(recordOf({ a: 1 }, "the fixture")).toEqual({ a: 1 });
    expect(() => recordOf(3, "the fixture")).toThrow("expected the fixture, found number");
    expect(maybeRecord({ a: 1 })).toEqual({ a: 1 });
    expect(maybeRecord(3)).toBeUndefined();
  });
});

describe("listOf / recordsOf", () => {
  it("returns a list and names a non-list", () => {
    expect(listOf([1, 2], "the rows")).toEqual([1, 2]);
    expect(() => listOf("nope", "the rows")).toThrow("expected the rows, found string");
    expect(recordsOf([{ id: 1 }, { id: 2 }], "the rows")).toEqual([{ id: 1 }, { id: 2 }]);
    expect(() => recordsOf([1], "the rows")).toThrow("expected the rows, found number");
  });
});

describe("scalar guards", () => {
  it("name the value they expected", () => {
    expect(stringOf("x", "the label")).toBe("x");
    expect(() => stringOf(1, "the label")).toThrow("expected the label to be a string");
    expect(numberOf(2, "the count")).toBe(2);
    expect(() => numberOf("2", "the count")).toThrow("expected the count to be a finite number");
    expect(() => numberOf(Number.NaN, "the count")).toThrow("expected the count to be a finite number");
    expect(booleanOf(false, "the flag")).toBe(false);
    expect(() => booleanOf("false", "the flag")).toThrow("expected the flag to be a boolean");
  });
});

describe("sessionIds", () => {
  it("reads the ids and names a bad list", () => {
    expect(sessionIds([{ sessionId: "s-1" }, { sessionId: "s-2" }])).toEqual(["s-1", "s-2"]);
    expect(() => sessionIds([{ sessionId: 1 }])).toThrow("expected session id to be a string");
    expect(() => sessionIds(3)).toThrow("expected session records, found number");
  });
});

describe("DOM guards", () => {
  it("prove a node and name the selector or value that failed", () => {
    document.body.innerHTML = '<div class="one"><button class="two"></button></div>';
    const one = elementOf(document, ".one", HTMLDivElement);
    expect(one.className).toBe("one");
    expect(elementsOf(document, "button", HTMLButtonElement)).toHaveLength(1);
    expect(instanceOf(one, HTMLElement, "the one element")).toBe(one);
    expect(() => elementOf(document, ".gone", HTMLElement)).toThrow(
      "expected .gone to be a HTMLElement",
    );
    expect(() => elementsOf(document, "div", HTMLButtonElement)).toThrow(
      "expected div to be a HTMLButtonElement",
    );
    expect(() => instanceOf(null, HTMLElement, "the one element")).toThrow(
      "expected the one element to be a HTMLElement",
    );
  });
});

describe("payload readers", () => {
  it("answer null for a shape they do not own", () => {
    expect(usageResult({ result: { account: null, pane: null } })).toEqual({
      account: null,
      pane: null,
    });
    expect(usageResult({ result: 3 })).toBeNull();
    expect(usageResult(null)).toBeNull();
    expect(statusEdge({ edge: { kind: "turn-start", at: 1 } })).toEqual({
      kind: "turn-start",
      at: 1,
    });
    expect(statusEdge({ edge: { kind: "turn-start" } })).toBeNull();
    expect(statusEdge(null)).toBeNull();
  });
});
