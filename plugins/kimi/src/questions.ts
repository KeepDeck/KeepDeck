import { asNonEmptyString, type TailWatch } from "@keepdeck/plugin-api";

/** Only root foreground questions block the pane. Arguments/answers stay on
 * disk; the projection carries one scheduling flag and the correlation id. */
export const kimiQuestionWatches: readonly TailWatch[] = [
  {
    match: [{ key: "type", equals: "context.append_loop_event" }, { key: "agentId", equals: "main" },
      { key: "event.type", equals: "tool.call" }, { key: "event.name", equals: "AskUserQuestion" }],
    keep: ["type", "agentId", "time", "event.type", "event.name", "event.toolCallId", "event.args.background"],
    lane: "status",
  },
  {
    match: [{ key: "type", equals: "context.append_loop_event" }, { key: "agentId", equals: "main" },
      { key: "event.type", equals: "tool.result" }],
    keep: ["type", "agentId", "time", "event.type", "event.toolCallId"], lane: "status",
  },
];

export function kimiQuestionCall(record: Readonly<Record<string, unknown>>) {
  const at = record.time;
  const id = asNonEmptyString(record["event.toolCallId"]);
  if (record.type !== "context.append_loop_event" || record.agentId !== "main" ||
    typeof at !== "number" || !Number.isFinite(at) || at < 0 || !id) return undefined;
  if (record["event.type"] === "tool.result") return { id, at, opening: false };
  if (record["event.type"] !== "tool.call" || record["event.name"] !== "AskUserQuestion") return undefined;
  const background = record["event.args.background"];
  if (background !== undefined && background !== false) return undefined;
  return { id, at, opening: true };
}
