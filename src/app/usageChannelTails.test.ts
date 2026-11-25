import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonl, type AgentUsage, type JsonlRequest, type SessionTailDialect, type TailWatch } from "@keepdeck/plugin-api";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { createDeckStore } from "./deckStore";
import { createDeckActions } from "./deckActions";
import { createPaneAttribution } from "./paneAttribution";
import type { AcceptedBinding } from "./sessionBinding";
import { createUsageManager } from "./usageManager";
import { createUsageSightings } from "./usageSightings";

/** The core as this lane reaches it: every command said in order, each
 * answered at once — or held until the test answers it. */
const core = vi.hoisted(() => {
  interface Held {
    resolve(value: unknown): void;
    reject(error: unknown): void;
  }
  const said: string[] = [];
  const holding = new Map<string, Held[]>();
  const waiting = new Set<string>();
  const answers: Record<string, unknown> = { retarget: true, link: true, since: null };
  return {
    said,
    /** The next command whose name starts with `name` waits for the test. */
    hold(name: string) {
      waiting.add(name);
    },
    call(name: string): Promise<unknown> {
      said.push(name);
      const held = [...waiting].find((prefix) => name.startsWith(prefix));
      if (held === undefined) return Promise.resolve(answers[name.split(" ")[0] ?? name]);
      waiting.delete(held);
      return new Promise((resolve, reject) => {
        holding.set(held, [...(holding.get(held) ?? []), { resolve, reject }]);
      });
    },
    answer(name: string, value?: unknown) {
      const [first, ...rest] = holding.get(name) ?? [];
      if (!first) throw new Error(`nothing held for ${name}`);
      holding.set(name, rest);
      first.resolve(value);
    },
    fail(name: string, error: unknown) {
      const [first, ...rest] = holding.get(name) ?? [];
      if (!first) throw new Error(`nothing held for ${name}`);
      holding.set(name, rest);
      first.reject(error);
    },
    plan: { token: "tok-1" } as { token: string } | undefined,
    planListeners: new Set<() => void>(),
    reset() {
      said.length = 0;
      holding.clear();
      waiting.clear();
      this.plan = { token: "tok-1" };
      this.planListeners.clear();
    },
  };
});

vi.mock("../ipc/usage", () => ({
  watchSessionFile: (_paneId: string, tail: { path: string }) => core.call(`watch ${tail.path}`),
  unwatchSessionFile: () => core.call("unwatch"),
  retargetSessionFile: () => core.call("retarget"),
  linkSessionFile: (_paneId: string, path: string) => core.call(`link ${path}`),
}));
vi.mock("../ipc/usageLedger", () => ({ usageSince: () => core.call("since") }));
vi.mock("./spawnSpecs", () => ({
  peekPaneSpawnSpec: () => core.plan,
  subscribeSpawnSpecs: (listener: () => void) => {
    core.planListeners.add(listener);
    return () => core.planListeners.delete(listener);
  },
}));
vi.mock("../ipc/log", () => ({ log: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
import { createUsageTailsLane } from "./usageChannelTails";

const usageWatch: TailWatch = { match: [{ key: "type", equals: "usage" }], keep: ["type"], lane: "usage" };

/** Let every promise already settled run its handlers. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** What the core was told that changes a tail, in order: the ledger's
 * questions left out, which change nothing and go when they are asked. */
const changes = () => core.said.filter((name) => name !== "since");

/** The last change the core was told of. */
const lastChange = () => changes()[changes().length - 1];

describe("the session-file tail lane", () => {
  afterEach(() => core.reset());

  /** A deck of one codex pane, this lane over it, and the bindings it hears. */
  const mount = (told: { dialect?: SessionTailDialect<JsonlRequest, unknown>; locate?: (id: string) => Promise<string | null>; session?: string } = {}) => {
    const store = createDeckStore();
    const deck = createDeckActions(store);
    deck.createWorkspace({
      id: "ws-1",
      instance: createWorkspaceInstance(),
      name: "ws",
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [{ id: "pane-1", agentType: "codex", ...(told.session ? { session: { id: told.session, boundAt: "2026-11-25T00:00:00Z" } } : {}) }],
    });
    const attribution = createPaneAttribution({
      workspaces: () => store.getSnapshot().workspaces,
      reports: () => true,
      swapSources: () => [],
    });
    const heard = new Set<(bound: AcceptedBinding) => void>();
    const usage: AgentUsage = { normalize: () => null, tail: { watches: [usageWatch], ...(told.locate && { locate: told.locate }) } };
    const lane = createUsageTailsLane({
      deck: store,
      attribution,
      bindings: {
        subscribe: (listener) => {
          heard.add(listener);
          return () => heard.delete(listener);
        },
      },
      declarations: { current: () => new Map([["codex", usage]]), subscribe: () => () => {} },
      usage: createUsageManager(),
      sightings: createUsageSightings(() => 0),
      tailOf: () => told.dialect,
      companionOf: () => ({ covers: ["status-records"] }),
    });
    const bind = (sessionId: string, transcriptPath: string) => {
      for (const listener of heard) listener({ paneId: "pane-1", sessionId, transcriptPath });
    };
    /** The pane's process said hello from the process it bound from. */
    const hello = () => {
      attribution.recordBinding("pane-1", "4242");
      attribution.recordCompanion("pane-1", "4242");
    };
    const retirePlan = () => {
      core.plan = undefined;
      for (const listener of core.planListeners) listener();
    };
    return { lane, bind, hello, retirePlan, deck };
  };

  it("sends no watch for an arming let go of while the ledger answered, and does not wait for the answer", async () => {
    const { lane, bind, retirePlan } = mount();
    core.hold("since");
    bind("s-1", "/store/s-1.jsonl");
    await settle();
    retirePlan();
    await settle();
    expect(core.said).toEqual(["since", "unwatch"]);
    core.answer("since", null);
    await settle();
    expect(core.said).toEqual(["since", "unwatch"]);
    lane.dispose();
  });

  it("holds up neither the let-go nor the next arming behind an answer the ledger owes a gone arming", async () => {
    const { lane, bind } = mount();
    core.hold("since");
    bind("s-1", "/store/s-1.jsonl");
    await settle();
    bind("s-2", "/store/s-2.jsonl");
    await settle();
    expect(core.said).toEqual(["since", "since", "unwatch", "watch /store/s-2.jsonl"]);
    lane.dispose();
  });

  it("sends nothing for a pane while its watch is on its way: an older arming never lands over a newer one", async () => {
    const { lane, bind } = mount();
    core.hold("watch /store/s-1");
    bind("s-1", "/store/s-1.jsonl");
    await settle();
    bind("s-2", "/store/s-2.jsonl");
    await settle();
    expect(changes()).toEqual(["watch /store/s-1.jsonl"]);
    core.answer("watch /store/s-1");
    await settle();
    expect(changes()).toEqual(["watch /store/s-1.jsonl", "unwatch", "watch /store/s-2.jsonl"]);
    lane.dispose();
  });

  it("narrows only the arming it was for: a refusal that lands after a newer one re-arms nothing", async () => {
    const { lane, bind, hello } = mount();
    bind("s-1", "/store/s-1.jsonl");
    await settle();
    core.hold("retarget");
    hello();
    await settle();
    bind("s-2", "/store/s-2.jsonl");
    await settle();
    expect(lastChange()).toBe("retarget");
    core.answer("retarget", false);
    await settle();
    expect(changes()).toEqual(["watch /store/s-1.jsonl", "retarget", "unwatch", "watch /store/s-2.jsonl"]);
    lane.dispose();
  });

  it("leaves a newer arming standing when an older narrowing fails", async () => {
    const { lane, bind, hello } = mount();
    bind("s-1", "/store/s-1.jsonl");
    await settle();
    core.hold("retarget");
    hello();
    await settle();
    bind("s-2", "/store/s-2.jsonl");
    await settle();
    expect(lastChange()).toBe("retarget");
    core.fail("retarget", new Error("the core went away"));
    await settle();
    // No let-go of the newer arming: only the one before it, as it armed.
    expect(changes()).toEqual(["watch /store/s-1.jsonl", "retarget", "unwatch", "watch /store/s-2.jsonl"]);
    lane.dispose();
    await settle();
    expect(lastChange()).toBe("unwatch");
  });

  it("links a store into the tail it was named in, never a newer one", async () => {
    let found = (_path: string | null) => {};
    const locate = () => new Promise<string | null>((resolve) => (found = resolve));
    const { lane, bind } = mount({ locate });
    bind("s-1", "/store/s-1.jsonl");
    await settle();
    lane.link("pane-1", ["child-1"], "s-1");
    await settle();
    // The pane moves on while the child's store is being found.
    bind("s-2", "/store/s-2.jsonl");
    await settle();
    found("/store/child-1.jsonl");
    await settle();
    expect(core.said.filter((name) => name.startsWith("link"))).toEqual([]);
    lane.dispose();
  });

  it("lets a link on its way to the core land before a newer arming lets its tail go", async () => {
    const { lane, bind } = mount({ locate: (id) => Promise.resolve(`/store/${id}.jsonl`) });
    bind("s-1", "/store/s-1.jsonl");
    await settle();
    core.hold("link");
    lane.link("pane-1", ["child-1"], "s-1");
    await settle();
    bind("s-2", "/store/s-2.jsonl");
    await settle();
    // Held: the core still follows the first tail, which the link was for.
    expect(lastChange()).toBe("link /store/child-1.jsonl");
    core.answer("link", true);
    await settle();
    expect(changes()).toEqual(["watch /store/s-1.jsonl", "link /store/child-1.jsonl", "unwatch", "watch /store/s-2.jsonl"]);
    lane.dispose();
  });

  it("links into a tail only the stores its own session's records named", async () => {
    const { lane, bind } = mount({ locate: (id) => Promise.resolve(`/store/${id}.jsonl`) });
    bind("s-1", "/store/s-1.jsonl");
    await settle();
    core.hold("unwatch");
    bind("s-2", "/store/s-2.jsonl");
    await settle();
    // A report of the tail just let go of, still on its way, names a store
    // of its own session: not the new tail's to read.
    lane.link("pane-1", ["child-old"], "s-1");
    lane.link("pane-1", ["child-new"], "s-2");
    await settle();
    core.answer("unwatch");
    await settle();
    expect(core.said.filter((name) => name.startsWith("link"))).toEqual(["link /store/child-new.jsonl"]);
    expect(core.said.indexOf("link /store/child-new.jsonl")).toBeGreaterThan(core.said.indexOf("watch /store/s-2.jsonl"));
    lane.dispose();
  });

  it("puts a pane whose arming failed back, to be armed on the next round", async () => {
    const dialect: SessionTailDialect<JsonlRequest, unknown> = {
      format: jsonl((value: unknown): value is unknown => value !== undefined),
      watches: [],
      follow: () => Promise.resolve({ path: "/store/s-1.jsonl" }),
      read: () => null,
      ignores: () => false,
    };
    const { lane, deck } = mount({ dialect, session: "s-1" });
    core.hold("watch");
    await settle();
    core.fail("watch", new Error("no thread for the tail"));
    await settle();
    // Anything the deck says rounds the lane again: the pane is searched for
    // and armed anew rather than left marked as armed by a tail that is not.
    deck.renamePane("ws-1", "pane-1", "the pane");
    await settle();
    expect(core.said.filter((name) => name.startsWith("watch"))).toEqual(["watch /store/s-1.jsonl", "watch /store/s-1.jsonl"]);
    lane.dispose();
  });
});
