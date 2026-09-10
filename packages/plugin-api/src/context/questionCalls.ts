import type { AgentStatusEvent } from "./status.ts";

/** Correlation only: each CLI decides which calls really block. Unrelated
 * tool results and duplicate deliveries cannot resolve a pending question. */
export type QuestionCalls = ReadonlyMap<string, number>;

export interface QuestionState {
  readonly calls: QuestionCalls;
  readonly at: number;
  readonly ended: boolean;
}

/** Source-time watermark prevents a delayed call from a retired turn becoming
 * a pending question in the next one. Only lifecycle/question facts advance it;
 * a faster, unrelated tool hook must not outrank a polled question. */
export function reduceQuestionStatus(
  current: QuestionState | undefined,
  edge: AgentStatusEvent | null,
  call?: { id: string; at: number; opening: boolean },
): { state: QuestionState | undefined; events: readonly AgentStatusEvent[] } {
  let state = current;
  if (edge) {
    const starts = edge.kind === "turn-start" || edge.kind === "turn-observed";
    const ends = edge.kind === "turn-end" || edge.kind === "turn-failed" || edge.kind === "interrupted";
    if ((starts || ends) && (!state || edge.at > state.at || (edge.at === state.at && (ends || state.ended)))) {
      state = { calls: new Map(), at: edge.at, ended: ends };
    }
  }
  const events = edge ? [edge] : [];
  if (!call || (state && (state.ended || call.at < state.at))) return { state, events };
  const changed = updateQuestionCalls(state?.calls ?? new Map(), call);
  if (changed.events.length === 0) return { state, events };
  return { state: { calls: changed.calls, at: call.at, ended: false }, events: [...events, ...changed.events] };
}

export function updateQuestionCalls(
  current: QuestionCalls,
  call: { id: string; at: number; opening: boolean },
): { calls: QuestionCalls; events: readonly AgentStatusEvent[] } {
  const since = current.get(call.id);
  if ((call.opening && since !== undefined) ||
    (!call.opening && (since === undefined || call.at < since))) return { calls: current, events: [] };
  const calls = new Map(current);
  if (call.opening) calls.set(call.id, call.at);
  else calls.delete(call.id);
  return { calls, events: [calls.size > 0
    ? { kind: "waiting", at: call.at, reason: "question" }
    : { kind: "resumed", at: call.at, reason: "question" }] };
}
