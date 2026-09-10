import { asNonEmptyString, reduceQuestionStatus, type AgentStatusEvent, type QuestionState,
  type StatusReduction, type TailWatch } from "@keepdeck/plugin-api";

type Record = Readonly<{ [key: string]: unknown }>;
interface DecoderState {
  readonly contextAt?: number;
  readonly mode?: string;
  readonly questions?: QuestionState;
}

// RequestUserInput itself is transient in 0.153.2. The direct function call is
// persisted BEFORE executing/awaiting the tool, even with code mode enabled.
// Only Plan mode blocks; Default and request_user_input_async do not.
export const codexQuestionWatches: readonly TailWatch[] = [
  { match: [{ key: "type", equals: "turn_context" }],
    keep: ["type", "timestamp", "payload.collaboration_mode.mode"], lane: "status", replayContext: true },
  ...["request_user_input", "functions.request_user_input"].map((name): TailWatch => ({
    match: [{ key: "type", equals: "response_item" }, { key: "payload.type", equals: "function_call" },
      { key: "payload.name", equals: name }],
    keep: ["type", "timestamp", "payload.type", "payload.name", "payload.call_id"], lane: "status",
  })),
  { match: [{ key: "type", equals: "response_item" }, { key: "payload.type", equals: "function_call_output" }],
    keep: ["type", "timestamp", "payload.type", "payload.call_id"], lane: "status" },
];

export function codexQuestionStatus(previous: unknown, record: Record | null, edge: AgentStatusEvent | null): StatusReduction {
  let state = previous as DecoderState | undefined;
  const at = typeof record?.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
  if (record?.type === "turn_context" && Number.isFinite(at) && at >= (state?.contextAt ?? -Infinity)) {
    state = { ...state, contextAt: at, mode: asNonEmptyString(record["payload.collaboration_mode.mode"]) ?? undefined };
  }
  const id = asNonEmptyString(record?.["payload.call_id"]);
  let call;
  if (record?.type === "response_item" && id && Number.isFinite(at)) {
    if (record["payload.type"] === "function_call_output") call = { id, at, opening: false };
    else if (record["payload.type"] === "function_call" && state?.mode === "plan" &&
      at >= (state.contextAt ?? -Infinity) &&
      (record["payload.name"] === "request_user_input" || record["payload.name"] === "functions.request_user_input")) {
      call = { id, at, opening: true };
    }
  }
  const reduced = reduceQuestionStatus(state?.questions, edge, call);
  if (reduced.state !== state?.questions) state = { ...state, questions: reduced.state };
  return { kind: "status-reduction", state, events: reduced.events };
}
