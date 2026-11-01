import {
  isJsonRecord,
  asNonEmptyString,
  jsonl,
  turnFailedEvent,
  type AgentHistory,
  type AgentPermissionMode,
  type AgentStatusEvent,
  type JsonlRequest,
  type SessionTailDialect,
  type TailWatch,
} from "@keepdeck/plugin-api";
import { kimiQuestionWatches } from "./questions";

type WireRecord = Readonly<Record<string, unknown>>;

/** A wire line is any JSON object. */
function isWireRecord(value: unknown): value is WireRecord {
  return isJsonRecord(value);
}

/** Kimi 0.40.1's durable MAIN-agent lifecycle, not its ambiguous Stop hook.
 * Stop runs on children too, and is suppressed after a Stop continuation.
 * The wire records the actual ending in both cases. Never carry prompt text. */
const watches: readonly TailWatch[] = [
  { match: [{ key: "type", equals: "turn.prompt" }, { key: "agentId", equals: "main" }],
    keep: ["type", "agentId", "time"], lane: "status" },
  { match: [{ key: "type", equals: "turn.ended" }, { key: "agentId", equals: "main" }],
    keep: ["type", "agentId", "time", "reason", "error.name", "error.message"], lane: "status" },
  ...["task.started", "task.terminated"].map((type): TailWatch => ({
    match: [{ key: "type", equals: type }, { key: "agentId", equals: "main" }],
    keep: ["type", "agentId", "time", "info.taskId", "info.detached"], lane: "status",
  })),
  // The mode the main agent runs in, recorded when it is set and on every
  // change — at once, not at the next turn. Live only: a resumed session's
  // older records speak for an older process.
  { match: [{ key: "type", equals: "permission.set_mode" }, { key: "agentId", equals: "main" }],
    keep: ["type", "agentId", "time", "mode"], lane: "status" },
  ...kimiQuestionWatches,
];

/**
 * kimi's own mode name → the host's. Matched by MEANING, not by name: kimi's
 * `auto` never asks, so it is the host's yolo; kimi's `yolo` is "ask when
 * needed" — it decides itself what to put to the user — so it is the host's
 * auto; `manual` asks (kimi 2.4.1, task-577). A name this dialect does not
 * know says nothing.
 */
export function kimiPermissionMode(mode: unknown): AgentPermissionMode | null {
  switch (mode) {
    case "auto":
      return "yolo";
    case "yolo":
      return "auto";
    case "manual":
      return "ask";
    default:
      return null;
  }
}

export const kimiRecords = {
  watches,
  read(record: WireRecord): AgentStatusEvent | null {
    const at = record.time;
    if (record.agentId !== "main" || typeof at !== "number" || !Number.isFinite(at) || at < 0) return null;
    switch (record.type) {
      case "turn.prompt": return { kind: "turn-observed", at };
      case "turn.ended":
        switch (record.reason) {
          case "completed": return { kind: "turn-end", at };
          case "cancelled":
          case "blocked": return { kind: "interrupted", at, scope: "main" };
          case "failed": return turnFailedEvent(at, record["error.name"], record["error.message"]);
          default: return null;
        }
      case "task.started":
      case "task.terminated": {
        // Only detached work automatically wakes the agent. Foreground task
        // completion is already covered by the main turn's own ending.
        const id = asNonEmptyString(record["info.taskId"]);
        if (!id || record["info.detached"] !== true) return null;
        return { kind: record.type === "task.started" ? "agent-turn-start" : "agent-turn-end", at, id };
      }
      case "permission.set_mode": {
        const mode = kimiPermissionMode(record.mode);
        return mode ? { kind: "permission-mode", at, mode } : null;
      }
      default: return null;
    }
  },
  // Correlated by the status normalizer, not a stateless record reader.
  ignores: (record: WireRecord) => record.type === "context.append_loop_event",
} satisfies Pick<SessionTailDialect<JsonlRequest, WireRecord>, "watches" | "read" | "ignores">;

/** Reuse history's discovery for a resumed pane whose SessionStart was missed. */
export const kimiTail = (
  history: Pick<AgentHistory, "list" | "listing">,
): SessionTailDialect<JsonlRequest, WireRecord> => ({
  format: jsonl(isWireRecord),
  ...kimiRecords,
  async follow({ store, sessionId }) {
    if (store) return { path: store };
    if (!sessionId) return null;
    const wanted = sessionId.startsWith("session_") ? sessionId : `session_${sessionId}`;
    const sessions = history.listing ? (await history.listing()).stubs : await history.list();
    const session = sessions.find((item) => item.sessionId === wanted);
    return session ? { path: session.ref } : null;
  },
});
