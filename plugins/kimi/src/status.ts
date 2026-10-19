import reporterManifest from "../resources/keepdeck-session-reporter/kimi.plugin.json";
import {
  asNonEmptyString,
  decodeStatusPayload,
  frameTeammateMail,
  reduceQuestionStatus,
  type AgentStatusEvent,
  type EventActor,
  type EventAttribution,
  type MailChannel,
  type MailReplyRenderer,
  type QuestionState,
  type StatusNormalizer,
} from "@keepdeck/plugin-api";
import { kimiRecords } from "./tail";
import { kimiQuestionCall } from "./questions";

/**
 * Messages waiting for this pane, in the shape kimi's hooks accept.
 *
 * kimi does NOT speak claude's hook-output schema, and this file used to
 * assume it did — `decision`/`reason` on `Stop`, a root `additionalContext`
 * on `UserPromptSubmit`. Both were dropped in silence, so kimi never
 * received a single message through this channel; the only ones that landed
 * came through the terminal. Its parser (`HookJsonOutputSchema`, read out of
 * the shipped 0.34.0 binary) accepts exactly two keys — `message` and
 * `hookSpecificOutput` — and is a LOOSE object, so anything else validates
 * fine and means nothing.
 *
 * `UserPromptSubmit` takes a plain `message`: kimi appends every non-blocking
 * hook message to the turn the person just opened, wrapped in its own
 * `<hook_result>` element.
 *
 * `Stop` is not a channel ([`KIMI_MAIL_CHANNELS`]). It could carry mail — a
 * block (`permissionDecision: "deny"`) makes kimi continue the turn with the
 * reason appended — but it fires for subagents with no agent identity, so a
 * message handed out there could land in a subagent and never reach the
 * agent it was written for.
 *
 * The framing is the point. `<teammate-message>` names whose words these
 * are and the sentence after it says how much authority they carry: another
 * agent's output, not the human's instruction. A terminal paste can say
 * neither, because it arrives as keystrokes indistinguishable from typing.
 */
export const renderKimiMail: MailReplyRenderer = ({ event, messages, waiting }) => {
  const text = frameTeammateMail(messages, waiting);
  switch (event.hook_event_name) {
    case "UserPromptSubmit":
      return JSON.stringify({ message: text });
    default:
      // Not a channel: the deck never asks this renderer about any other
      // event.
      return null;
  }
};

/**
 * Where kimi's hooks ask for mail: exactly the events the companion
 * manifest arms with `--ask`, so the manifest is the one list. That is
 * `UserPromptSubmit` alone. `Stop` fires for subagents too, with no agent
 * identity, so mail handed out there could land in a subagent — kimi takes
 * mail as a turn starts, and a pane whose turn is running is woken once it
 * ends. None of kimi's channels runs at turn end.
 */
export const KIMI_MAIL_CHANNELS: readonly MailChannel[] = reporterManifest.hooks
  .filter((hook) => hook.command.split(" ").includes("--ask"))
  .map((hook) => ({ event: hook.event, atTurnEnd: false }));

/**
 * Whose report this is, in kimi's terms.
 *
 * - `UserPromptSubmit` runs only for prompts of origin `user` — never a
 *   subagent's — so it is the main agent's.
 * - The permission pair carries `agent_id`, `"main"` for the main agent.
 * - `Stop`, `Interrupt` and `StopFailure` carry no agent identity and fire for
 *   subagents too: nobody can say whose they are, and the main wire reports
 *   the real endings, so they move nothing.
 * - A record of the main wire is the main agent's.
 */
export const attributeKimiEvent = (payload: unknown): EventAttribution | null => {
  const decoded = decodeStatusPayload(payload);
  if (!decoded) return null;
  if (decoded.source === "record") return { event: null, actor: "main", status: true };
  const event = asNonEmptyString(decoded.event.hook_event_name);
  if (!event) return null;
  let actor: EventActor = "unknown";
  if (!decoded.reduced) {
    if (event === "UserPromptSubmit") actor = "main";
    else if (event === "PermissionRequest" || event === "PermissionResult") {
      const agentId = asNonEmptyString(decoded.event.agent_id);
      actor = agentId === "main" ? "main" : agentId ? "child" : "unknown";
    }
  }
  const status = event === "UserPromptSubmit" ? actor !== "child" : actor === "main";
  return { event, actor, status };
};

/**
 * kimi's turn-lifecycle payloads → status edges. The reporter (a hook in
 * the user-installed companion plugin) wraps each payload verbatim under
 * `event`; base fields per kimi's hooks doc: `{hook_event_name, session_id,
 * cwd}`, snake_case.
 *
 * Terminal hooks have no agent identity in 0.40.1 and fire on child agents
 * too. They are mail boundaries, not pane endings. The main wire supplies
 * actual completion/failure/cancellation, including after Stop continuation.
 */
const readKimiStatus = (
  payload: unknown,
  at: number,
): AgentStatusEvent | null => {
  const decoded = decodeStatusPayload(payload);
  if (!decoded) return null;
  if (decoded.source === "record") return kimiRecords.read(decoded.record);
  const event = decoded.event;
  switch (event.hook_event_name) {
    case "UserPromptSubmit":
      return { kind: "turn-start", at };
    case "Stop":
    case "Interrupt":
    case "StopFailure":
      return null;
    case "PermissionRequest":
      return { kind: "waiting", at, reason: "permission" };
    case "PermissionResult":
      return { kind: "resumed", at, reason: "permission" };
    default:
      return null;
  }
};

export const normalizeKimiStatus: StatusNormalizer = (payload, at, context) => {
  const decoded = decodeStatusPayload(payload);
  const record = decoded?.source === "record" ? decoded.record : null;
  const result = reduceQuestionStatus(context?.state as QuestionState | undefined,
    readKimiStatus(payload, at), record ? kimiQuestionCall(record) : undefined);
  return { kind: "status-reduction", ...result };
};
