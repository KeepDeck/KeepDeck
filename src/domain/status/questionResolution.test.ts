import { expect, it } from "vitest";
import { reduceStatus } from "./activity";

it("only a matching, non-stale resolution clears a question", () => {
  const waiting = reduceStatus(null, { kind: "waiting", at: 200, reason: "question" });
  expect(reduceStatus(waiting, { kind: "resumed", at: 300, reason: "permission" })).toBe(waiting);
  expect(reduceStatus(waiting, { kind: "resumed", at: 199, reason: "question" })).toBe(waiting);
  expect(reduceStatus(waiting, { kind: "resumed", at: 300, reason: "question" })?.activity)
    .toEqual({ state: "working", since: 300 });
});
