import { expect, it } from "vitest";
import { reduceQuestionStatus, updateQuestionCalls } from "./questionCalls";

it("only the last matching answer closes the wait, without mutating the checkpoint", () => {
  const empty = new Map<string, number>();
  const first = updateQuestionCalls(empty, { id: "one", at: 100, opening: true });
  expect(empty.size).toBe(0);
  const both = updateQuestionCalls(first.calls, { id: "two", at: 110, opening: true });
  expect(updateQuestionCalls(both.calls, { id: "other", at: 120, opening: false }).events).toEqual([]);
  expect(updateQuestionCalls(both.calls, { id: "one", at: 99, opening: false }).calls).toBe(both.calls);
  expect(updateQuestionCalls(both.calls, { id: "one", at: 120, opening: true }).events).toEqual([]);
  const oneLeft = updateQuestionCalls(both.calls, { id: "one", at: 130, opening: false });
  expect(oneLeft.events).toEqual([{ kind: "waiting", at: 130, reason: "question" }]);
  expect(updateQuestionCalls(oneLeft.calls, { id: "two", at: 140, opening: false }).events)
    .toEqual([{ kind: "resumed", at: 140, reason: "question" }]);
});

it("retires calls at turn boundaries and ignores old calls, answers and endings", () => {
  const first = reduceQuestionStatus(undefined, { kind: "turn-start", at: 100 });
  const asked = reduceQuestionStatus(first.state, null, { id: "one", at: 200, opening: true });
  const lateStart = reduceQuestionStatus(asked.state, { kind: "turn-observed", at: 100 });
  expect(lateStart.state).toBe(asked.state);
  const next = reduceQuestionStatus(asked.state, { kind: "turn-start", at: 300 });
  expect(next.state?.calls.size).toBe(0);
  expect(reduceQuestionStatus(next.state, null, { id: "late", at: 200, opening: true }).events).toEqual([]);
  expect(reduceQuestionStatus(next.state, { kind: "interrupted", at: 250 }).state).toBe(next.state);
  const ended = reduceQuestionStatus(next.state, { kind: "turn-end", at: 400 });
  expect(reduceQuestionStatus(ended.state, null, { id: "echo", at: 401, opening: true }).events).toEqual([]);
  const started = reduceQuestionStatus(ended.state, { kind: "turn-observed", at: 400 });
  expect(reduceQuestionStatus(started.state, null, { id: "new", at: 400, opening: true }).events)
    .toEqual([{ kind: "waiting", at: 400, reason: "question" }]);
});
