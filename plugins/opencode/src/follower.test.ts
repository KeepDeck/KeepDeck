import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDeck } from "../../../scripts/reporterHarness";

/**
 * The pane follows the TUI (task-435): the user opens another session, and
 * that session becomes the pane's conversation — the binding first, its spend
 * right after, and only then the courier's question about mail.
 *
 * Run over the real reporter, courier and follower, against a stand-in deck,
 * with the route written the way the TUI half writes it.
 */
let startReporter: (input?: any) => Promise<any>;
let startCourier: (input?: any) => Promise<any>;
let follower: () => { start(dir?: string, tui?: number): void; screen(): unknown };
let writeForeground: (dir: string, route: Record<string, unknown>, now?: number, pid?: number) => void;
let paneSession: () => { root: string | undefined };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (done: () => boolean) => {
  for (let i = 0; i < 400 && !done(); i++) await sleep(5);
};

describe("the pane follows the session on screen", () => {
  let dir: string;
  let deck: Awaited<ReturnType<typeof startDeck>>;
  /** sessionID → parent, as the client answers; absent = a root; `null` = the
   * client cannot tell. */
  let parents: Record<string, string | null | undefined>;

  const client = () => ({
    session: {
      get: async ({ path }: { path: { id: string } }) =>
        parents[path.id] === null
          ? { error: { name: "UnknownError" } }
          : { data: { id: path.id, parentID: parents[path.id] } },
      // The session's history, as hydration reads it: one finished turn.
      messages: async ({ path }: { path: { id: string } }) => ({
        data: [
          {
            info: {
              id: `msg_${path.id}`,
              role: "assistant",
              sessionID: path.id,
              providerID: "anthropic",
              modelID: "claude-sonnet-5",
              time: { completed: 1 },
              cost: 0.25,
              tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
            },
            parts: [],
          },
        ],
      }),
      children: async () => ({ data: [] }),
      promptAsync: async () => ({ data: {} }),
    },
    config: { providers: async () => ({ data: { providers: [] } }) },
  });

  beforeEach(async () => {
    vi.resetModules();
    ({ startReporter } = await import("../resources/keepdeck-plugin/session-reporter.js"));
    ({ startCourier } = await import("../resources/keepdeck-plugin/mail-courier.js"));
    ({ follower } = await import("../resources/keepdeck-plugin/follower.js"));
    ({ writeForeground } = await import("../resources/keepdeck-plugin/foreground.js"));
    ({ paneSession } = await import("../resources/keepdeck-plugin/pane-session.js"));
    dir = mkdtempSync(join(tmpdir(), "kd-follow-"));
    deck = await startDeck();
    process.env.KEEPDECK_BRIDGE = JSON.stringify({ v: 2, dir, pane: "pane-3", token: "tok", url: deck.url });
    parents = {};
  });

  afterEach(async () => {
    delete process.env.KEEPDECK_BRIDGE;
    await deck.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Both components bound to `ses_a`, and the follower watching. */
  const startOn = async (root: string, tui?: number) => {
    const c = client();
    const reporter = await startReporter({ client: c });
    const courier = await startCourier({ client: c });
    const created = { event: { type: "session.created", properties: { info: { id: root } } } };
    await reporter.event(created);
    await courier.event(created);
    follower().start(dir, tui);
    await until(() => deck.envelopes.some((e: any) => e.type === "session.bound"));
    deck.envelopes.length = 0;
  };

  const types = () => deck.envelopes.map((e: any) => e.type === "agent.status" ? e.payload?.event?.type : e.type);

  it("binds the session the user opened, publishes its spend, and only then asks for its mail", async () => {
    await startOn("ses_a");
    writeForeground(dir, { route: "session", sessionID: "ses_b" });
    await until(() => types().includes("mail.ask"));

    expect(paneSession().root).toBe("ses_b");
    const bound = deck.envelopes.find((e: any) => e.type === "session.bound");
    // A session the user went to is the pane's conversation continuing, not
    // a second startup.
    expect(bound.payload).toMatchObject({ sessionId: "ses_b", source: "resume" });
    // The deck hears the binding before anything else about the session,
    // its spend at once rather than at its next turn, and the courier asks
    // only after both are out.
    const order = types();
    expect(order.indexOf("session.bound")).toBe(0);
    expect(order.indexOf("usage.report")).toBeGreaterThan(0);
    expect(order.indexOf("mail.ask")).toBeGreaterThan(order.indexOf("usage.report"));
    const usage = deck.envelopes.find((e: any) => e.type === "usage.report");
    expect(usage.payload).toMatchObject({ sessionId: "ses_b", costUsd: 0.25 });
    // One move, one collection: the follower tells the courier once.
    await sleep(100);
    expect(types().filter((type) => type === "mail.ask")).toHaveLength(1);
  });

  it("stays on the conversation when the user only looks at one of its subagents", async () => {
    await startOn("ses_a");
    parents.ses_sub = "ses_a";
    writeForeground(dir, { route: "session", sessionID: "ses_sub" });
    await sleep(150);
    expect(paneSession().root).toBe("ses_a");
    expect(types()).not.toContain("session.bound");
  });

  it("does not move to a session nobody can classify — it might be somebody's leaf", async () => {
    await startOn("ses_a");
    parents.ses_x = null;
    writeForeground(dir, { route: "session", sessionID: "ses_x" });
    await sleep(150);
    expect(paneSession().root).toBe("ses_a");
    expect(types()).not.toContain("session.bound");
  });

  it("leaves the pane alone on the home screen — that is the leaving, not a move", async () => {
    await startOn("ses_a");
    writeForeground(dir, { route: "home" });
    await sleep(150);
    expect(paneSession().root).toBe("ses_a");
    expect(types()).not.toContain("session.bound");
  });

  it("follows the TUI it was started for, and reads the screen through that TUI alone", async () => {
    // opencode 2.x: the TUI is the server plugin's PARENT process (task-436).
    const tui = process.pid + 1;
    await startOn("ses_a", tui);
    writeForeground(dir, { route: "session", sessionID: "ses_c" }, Date.now(), process.pid);
    await sleep(150);
    expect(paneSession().root).toBe("ses_a");
    expect(follower().screen()).toEqual({ kind: "unknown" });

    writeForeground(dir, { route: "session", sessionID: "ses_b" }, Date.now(), tui);
    await until(() => paneSession().root === "ses_b");
    expect(paneSession().root).toBe("ses_b");
    expect(follower().screen()).toEqual({ kind: "session", sessionID: "ses_b" });
  });
});
