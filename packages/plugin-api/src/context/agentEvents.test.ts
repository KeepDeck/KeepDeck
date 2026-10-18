import { describe, expect, it, vi } from "vitest";
import {
  admitMail,
  admittedNormalizer,
  collectsAtTurnEnd,
  mailAskArgs,
  type EventActor,
  type EventAttribution,
  type MailChannel,
} from "./agentEvents";
import { CARRIED_RECORD } from "./sessionTail";
import type { MailReplyRenderer } from "./status";

const render: MailReplyRenderer = () => "rendered";
const channels: MailChannel[] = [
  { event: "UserPromptSubmit", atTurnEnd: false },
  { event: "Stop", atTurnEnd: true },
];
const hook = (event: string, extra: Record<string, unknown> = {}) => ({
  agent: "x",
  event: { hook_event_name: event },
  ...extra,
});
/** A plugin whose attribution is fixed for the test. */
const agent = (actor: EventActor, status = true) => ({
  normalize: vi.fn(() => ({ kind: "turn-start" as const, at: 1 })),
  attribute: (payload: unknown): EventAttribution | null => {
    const event = (payload as { event?: { hook_event_name?: string } }).event?.hook_event_name;
    return { event: event ?? null, actor, status };
  },
  mail: { channels, render },
});

describe("admitMail", () => {
  it("hands the renderer over only for the main agent, whole, on a declared channel", () => {
    expect(admitMail(agent("main"), hook("Stop"))).toEqual({ render });
    expect(admitMail(agent("main"), hook("UserPromptSubmit"))).toEqual({ render });
  });

  it("refuses a subagent and a caller nobody can name", () => {
    expect(admitMail(agent("child"), hook("Stop"))).toEqual({ refused: "raised by a subagent" });
    expect(admitMail(agent("unknown"), hook("Stop"))).toHaveProperty("refused");
  });

  it("refuses a payload the reporter reduced, even from the main agent", () => {
    expect(admitMail(agent("main"), hook("Stop", { reduced: true }))).toEqual({
      refused: "the payload was reduced",
    });
  });

  it("refuses an event that is not a declared channel", () => {
    expect(admitMail(agent("main"), hook("PostToolUse"))).toEqual({
      refused: "the event is not a mail channel",
    });
  });

  it("refuses a store record, an unreadable event, and an agent with no mail", () => {
    expect(admitMail(agent("main"), { agent: "x", kind: CARRIED_RECORD, record: {} })).toHaveProperty("refused");
    expect(admitMail({ ...agent("main"), attribute: () => null }, hook("Stop"))).toHaveProperty("refused");
    expect(admitMail({ attribute: agent("main").attribute }, hook("Stop"))).toHaveProperty("refused");
  });

  it("is independent of whether the report may move the pane", () => {
    // Status and mail are separate questions: a main-agent ask that moves
    // nothing still collects.
    expect(admitMail(agent("main", false), hook("Stop"))).toEqual({ render });
  });
});

describe("admittedNormalizer", () => {
  it("runs the plugin's normalizer only for reports allowed to move the pane", () => {
    const allowed = agent("child", true);
    expect(admittedNormalizer(allowed)(hook("PostToolUse"), 1)).toEqual({ kind: "turn-start", at: 1 });
    const denied = agent("child", false);
    expect(admittedNormalizer(denied)(hook("UserPromptSubmit"), 1)).toBeNull();
    expect(denied.normalize).not.toHaveBeenCalled();
  });

  it("denies a payload the plugin cannot attribute", () => {
    const unreadable = { ...agent("main"), attribute: () => null };
    expect(admittedNormalizer(unreadable)(hook("Stop"), 1)).toBeNull();
    expect(unreadable.normalize).not.toHaveBeenCalled();
  });
});

describe("collectsAtTurnEnd", () => {
  it("is what the channels declare, not whether a renderer exists", () => {
    expect(collectsAtTurnEnd({ channels, render })).toBe(true);
    // kimi: a renderer, but asking only as a turn starts.
    expect(collectsAtTurnEnd({ channels: [channels[0]], render })).toBe(false);
    expect(collectsAtTurnEnd(undefined)).toBe(false);
  });
});

describe("mailAskArgs", () => {
  it("asks exactly on declared channels", () => {
    expect(mailAskArgs(channels, "Stop")).toEqual(["--ask"]);
    expect(mailAskArgs(channels, "PermissionRequest")).toEqual([]);
  });
});
