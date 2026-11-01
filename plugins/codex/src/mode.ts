/**
 * The mode a codex turn really runs in, from the settings its rollout records
 * for it — `turn_context`'s approval policy and sandbox, which codex writes as
 * the turn starts, AFTER any managed requirement had its say. A forbidden
 * `--dangerously-bypass-approvals-and-sandbox` falls back to the first
 * allowed value (a startup warning in the TUI), and what this record carries
 * is that fallback, not the flag (task-577, read in codex's config at
 * 67f0994b).
 *
 * Not from the hook payloads' `permission_mode`: codex builds it from the
 * approval policy alone, so it can show a turn is not YOLO but never that it
 * is — a turn that never asks inside a sandbox reads as bypass there.
 */
import { asNonEmptyString, parseInstant, type AgentPermissionMode, type AgentStatusEvent } from "@keepdeck/plugin-api";

/** The fields the shared `turn_context` watch carries, by their dotted names. */
type CarriedTurnContext = Readonly<{ [key: string]: unknown }>;

/**
 * codex's approval policy and sandbox → the host's mode. YOLO is BOTH halves:
 * never asking, and no sandbox (`danger-full-access`, or the newer profile
 * model's `disabled`). Never asking inside a sandbox is codex deciding on its
 * own what it may do — `auto`. Any approval that asks is `ask`. An approval
 * this dialect does not know, or a never-asking turn whose sandbox it cannot
 * read, says nothing.
 */
export function codexPermissionMode(
  approval: unknown,
  sandbox: unknown,
  profile: unknown,
): AgentPermissionMode | null {
  switch (approval) {
    case "untrusted":
    case "on-failure":
    case "on-request":
      return "ask";
    case "never": {
      if (sandbox === "danger-full-access" || profile === "disabled") return "yolo";
      return asNonEmptyString(sandbox) || asNonEmptyString(profile) ? "auto" : null;
    }
    default:
      return null;
  }
}

/** The mode one carried `turn_context` says its turn runs in, at the
 * record's own time. Anything else carried says nothing about the mode. */
export function codexModeEdge(record: CarriedTurnContext): AgentStatusEvent | null {
  if (record.type !== "turn_context") return null;
  const at = parseInstant(record.timestamp);
  if (at === null) return null;
  const mode = codexPermissionMode(
    record["payload.approval_policy"],
    record["payload.sandbox_policy.type"],
    record["payload.permission_profile.type"],
  );
  return mode ? { kind: "permission-mode", at, mode } : null;
}
