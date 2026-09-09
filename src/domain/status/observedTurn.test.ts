import { expect, it } from "vitest";
import { reduceStatus } from "./activity";
import type { AgentStatusEvent } from "@keepdeck/plugin-api";

it.each<AgentStatusEvent>([
  { kind: "turn-end", at: 200 },
  { kind: "interrupted", at: 200 },
  { kind: "turn-failed", at: 200, error: "rate_limit" },
])("preserves ordered execution starts sharing a millisecond with $kind", (ending) => {
  const ended = reduceStatus(reduceStatus(null, { kind: "turn-start", at: 100 }), ending);
  expect(reduceStatus(ended, { kind: "turn-observed", at: 199 })).toBe(ended);
  expect(reduceStatus(ended, { kind: "turn-observed", at: 200 })?.activity)
    .toEqual({ state: "working", since: 200 });
});

it("a repeated start cannot clear a wait sharing its timestamp", () => {
  const waiting = reduceStatus(null, { kind: "waiting", at: 200, reason: "question" });
  expect(reduceStatus(waiting, { kind: "turn-observed", at: 200 })).toBe(waiting);
});
