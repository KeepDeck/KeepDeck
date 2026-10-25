import { describe, expect, it, vi } from "vitest";
import { frameTeammateMail } from "@keepdeck/plugin-api";
// Untyped resource JS — shipped to, and loaded by, the user's opencode.
// @ts-expect-error untyped resource module
import { MAIL_FRAME, promptSelection } from "../resources/keepdeck-plugin/prompt-selection.js";

type Part = { type: string; text?: string; synthetic?: boolean };
type Row = { info: Record<string, unknown>; parts: Part[] };

const user = (parts: Part[], over: Record<string, unknown> = {}): Row => ({
  info: {
    role: "user",
    agent: "custom",
    model: { providerID: "probe", modelID: "alt", variant: "max" },
    ...over,
  },
  parts,
});
const assistant: Row = { info: { role: "assistant" }, parts: [{ type: "text", text: "ok" }] };
const said = (text: string): Part => ({ type: "text", text });
const mail = said(`${MAIL_FRAME}\n[mail-1 · task · from lead]\n> do it\n</teammate-message>`);

/** A client answering `session.messages` with the newest `limit` rows of
 * `rows`, in chronological order, the way the 1.19.3 server does. */
const clientOver = (rows: Row[]) => {
  const messages = vi.fn(async (call: { path: { id: string }; query: { limit: number } }) => ({
    data: rows.slice(-call.query.limit),
  }));
  return { client: { session: { messages } }, messages };
};

const COPIED = {
  agent: "custom",
  model: { providerID: "probe", modelID: "alt" },
  variant: "max",
};

describe("the selection a delivery repeats", () => {
  it("is the newest message the user sent: agent, model and variant", async () => {
    const { client, messages } = clientOver([
      user([said("first")], { agent: "build", model: { providerID: "p", modelID: "old" } }),
      assistant,
      user([said("latest")]),
      assistant,
    ]);
    expect(await promptSelection(client, "ses_1")).toEqual(COPIED);
    expect(messages.mock.calls[0][0].path).toEqual({ id: "ses_1" });
  });

  it("passes over everything KeepDeck wrote: the brief, a teammate's message, a shell command", async () => {
    // Each of these is a USER message to opencode, and each would otherwise
    // be copied — a pre-fix delivery carries the default agent, so copying it
    // keeps the bug alive.
    const blank = { agent: "build", model: { providerID: "p", modelID: "default" } };
    const { client } = clientOver([
      user([said("mine")]),
      assistant,
      user([{ type: "text", text: "you are analyst-2", synthetic: true }], blank),
      user([mail], blank),
      user([{ type: "text", text: "ls -la", synthetic: true }], blank),
    ]);
    expect(await promptSelection(client, "ses_1")).toEqual(COPIED);
  });

  it("counts the user's message that our mail rode along inside, and one with attached files", async () => {
    const { client } = clientOver([
      user([said("look at this"), { type: "text", text: "<file contents>", synthetic: true }, mail]),
    ]);
    expect(await promptSelection(client, "ses_1")).toEqual(COPIED);
  });

  it("looks further back when a long exchange buried the user's last message", async () => {
    const theirs = Array.from({ length: 30 }, () => user([mail], { agent: "build" }));
    const { client, messages } = clientOver([user([said("mine")]), ...theirs]);
    expect(await promptSelection(client, "ses_1")).toEqual(COPIED);
    expect(messages.mock.calls.map(([call]) => call.query.limit)).toEqual([20, 200]);
  });

  it("is nothing — today's behaviour — when the user never wrote here, or the session cannot be read", async () => {
    const short = clientOver([user([mail]), assistant]);
    expect(await promptSelection(short.client, "s")).toEqual({});
    // Fewer rows than the window asked for IS the whole session: no wider read.
    expect(short.messages).toHaveBeenCalledTimes(1);
    expect(await promptSelection(clientOver([]).client, "s")).toEqual({});
    const failing = { session: { messages: async () => ({ error: { name: "UnknownError" } }) } };
    expect(await promptSelection(failing, "s")).toEqual({});
    const throwing = { session: { messages: async () => { throw new Error("gone"); } } };
    expect(await promptSelection(throwing, "s")).toEqual({});
    expect(await promptSelection({}, "s")).toEqual({});
  });

  it("leaves out what the message does not say", async () => {
    const { client } = clientOver([
      user([said("mine")], { agent: "", model: { providerID: "probe", modelID: "alt" } }),
    ]);
    expect(await promptSelection(client, "s")).toEqual({
      model: { providerID: "probe", modelID: "alt" },
    });
  });

  it("recognizes KeepDeck's mail by the frame the deck actually writes", () => {
    // The resource cannot import plugin-api; this keeps its copy honest.
    const framed = frameTeammateMail([
      { id: "mail-1", kind: "task", from: "lead", body: "x", standing: false },
    ]);
    expect(framed.startsWith(MAIL_FRAME)).toBe(true);
  });
});
