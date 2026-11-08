// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  jsonl,
  type AgentUsage,
  type CompanionCover,
  type JsonlRequest,
  type SessionTailDialect,
  type TailWatch,
  type TailTarget,
} from "@keepdeck/plugin-api";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import type { TailArming } from "../ipc/usage";
import { createDeckStore } from "./deckStore";
import { createDeckActions, type DeckActions } from "./deckActions";

const ipc = vi.hoisted(() => ({
  watchSessionFile: vi.fn<(paneId: string, tail: TailArming) => Promise<void>>(() =>
    Promise.resolve(),
  ),
  unwatchSessionFile: vi.fn(() => Promise.resolve()),
  retargetSessionFile: vi.fn<(paneId: string, watches: readonly TailWatch[]) => Promise<boolean>>(
    () => Promise.resolve(true),
  ),
  linkSessionFile: vi.fn<(paneId: string, path: string) => Promise<boolean>>(() =>
    Promise.resolve(true),
  ),
  usageSince: vi.fn<(agent: string, sessionId: string, firstSeen: number) => Promise<number>>(
    (_agent, _sessionId, firstSeen) => Promise.resolve(firstSeen),
  ),
  findCodexRollout: vi.fn<(sessionId: string) => Promise<string | null>>(() =>
    Promise.resolve("/rollout.jsonl"),
  ),
  onSessionBound: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("../ipc/usage", () => ({
  watchSessionFile: ipc.watchSessionFile,
  unwatchSessionFile: ipc.unwatchSessionFile,
  retargetSessionFile: ipc.retargetSessionFile,
  linkSessionFile: ipc.linkSessionFile,
  findCodexRollout: ipc.findCodexRollout,
}));
vi.mock("../ipc/usageLedger", () => ({ usageSince: ipc.usageSince }));
vi.mock("../ipc/sessions", () => ({ onSessionBound: ipc.onSessionBound }));
vi.mock("../ipc/log", () => ({
  log: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

// The spawn token is what a tail authenticates with. Suspend drops the spec,
// and the resume mints a NEW token — which is the whole point of these tests.
const specs = vi.hoisted(() => ({ token: "token-1" as string | null }));
vi.mock("./spawnSpecs", () => ({
  peekPaneSpawnSpec: () => (specs.token ? { token: specs.token } : undefined),
  // Present for the binding lane composed below; these tests build no fork
  // plan, so there is nothing for it to stamp.
  bindPaneSpawnSpecSession: () => {},
}));
import { createUsageTailsLane } from "./usageChannelTails";
import type { UsageLane } from "./usageChannelSource";
import type { AcceptedBinding } from "./sessionBinding";

/** A dialect as the tails lane uses one: what to carry and where the store
 * is. It reads no record here. */
const dialectOf = (
  watches: readonly TailWatch[],
  follow: (pane: TailTarget) => Promise<JsonlRequest | null>,
): SessionTailDialect<JsonlRequest, unknown> => ({
  format: jsonl((_record: unknown): _record is unknown => true),
  watches,
  follow,
  read: () => null,
  ignores: () => true,
});
import { createUsageManager } from "./usageManager";
import { createUsageSightings } from "./usageSightings";
import { createPaneAttribution } from "./paneAttribution";
import {
  createSessionBinding,
  type SessionBinding,
} from "./sessionBinding";
import { present } from "@keepdeck/plugin-api/testing";

const usageByAgent = new Map<string, AgentUsage>([
  [
    "codex",
    // Only `tail` is read here; the lane never normalizes in these tests.
    { normalize: () => null, tail: { watches: [] } },
  ],
]);

let deck: DeckActions;

function seed() {
  act(() => {
    deck.createWorkspace({
      id: "ws-1",
      instance: createWorkspaceInstance(),
      name: "ws",
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [
        {
          id: "pane-1",
          agentType: "codex",
          session: { id: "s-1", boundAt: "2026-07-25T09:00:00.000Z" },
        },
      ],
    });
  });
}

describe("usage tails — a suspended pane's watcher", () => {
  let lane: UsageLane;
  let bindings: SessionBinding;

  beforeEach(() => {
    ipc.watchSessionFile.mockClear();
    ipc.unwatchSessionFile.mockClear();
    ipc.findCodexRollout.mockClear();
    specs.token = "token-1";
    const store = createDeckStore();
    deck = createDeckActions(store);
    // The real rule and the real binding lane over it, as the runtime
    // composes them — the tails lane follows what the binding lane accepted.
    const attribution = createPaneAttribution({
      workspaces: () => store.getSnapshot().workspaces,
      secretOf: () => specs.token ?? undefined,
      swapSources: () => ["resume", "clear", "compact", "fork"],
    });
    bindings = createSessionBinding(
      store,
      { retire: () => {}, beginSession: () => {}, endSession: () => {} },
      attribution,
    );
    lane = createUsageTailsLane({
      deck: store,
      attribution,
      bindings,
      // These panes reach the tail through the FALLBACK — a recorded session
      // with no binding — and finding the store is now the dialect's answer
      // rather than a command of the host's. The fake is that search, over
      // the same mocked lookup this file already had.
      tailOf: () =>
        dialectOf([], async ({ sessionId }) => {
          const path = sessionId ? await ipc.findCodexRollout(sessionId) : null;
          return path ? { path } : null;
        }),
      // The tails lane only arms watchers; events reach the store via the
      // reports lane, so a fresh, unobserved instance satisfies the context.
      companionOf: () => undefined,
      usage: createUsageManager(),
      sightings: createUsageSightings(),
      declarations: {
        current: () => usageByAgent,
        subscribe: () => () => {},
      },
    });
  });

  afterEach(() => {
    lane.dispose();
  });

  const settle = async () => {
    for (let i = 0; i < 4; i++) await act(async () => {});
  };

  it("is released on suspend and re-armed on resume, with the NEW token", async () => {
    // Suspend drops the pane's spawn spec, so the resume mints a fresh token
    // (`spawnSpecs`: the cached one is gone). A watcher kept across that
    // rotation still echoes the OLD token, so every report it sends is
    // rejected as unauthenticated — the pane's usage goes silently dead for
    // the rest of its life, because the fallback lane never re-arms a pane it
    // still believes is tailed. Releasing it on suspend is what makes the
    // resume able to arm a live one.
    seed();
    await settle();
    expect(ipc.watchSessionFile).toHaveBeenCalledTimes(1);
    expect(ipc.watchSessionFile.mock.calls[0][1].token).toBe("token-1");

    act(() => deck.suspendPane("ws-1", "pane-1"));
    await settle();
    expect(ipc.unwatchSessionFile).toHaveBeenCalledWith("pane-1");

    // The resume: a new process, a new token.
    specs.token = "token-2";
    act(() => deck.requestPaneWake("ws-1", "pane-1"));
    act(() => deck.clearPaneIdle("ws-1", "pane-1"));
    await settle();

    expect(ipc.watchSessionFile).toHaveBeenCalledTimes(2);
    expect(ipc.watchSessionFile.mock.calls[1][1].token).toBe("token-2");
  });

  it("keeps tailing a pane that is merely rising", async () => {
    // A pane on its way up still owns its process-to-be; only a pane that is
    // really stopped has a dead file behind it.
    seed();
    await settle();
    ipc.unwatchSessionFile.mockClear();

    act(() => deck.suspendPane("ws-1", "pane-1"));
    act(() => deck.requestPaneWake("ws-1", "pane-1"));
    await settle();

    // It was released by the suspend and not re-armed while still idle —
    // arming needs a live spawn token, which a rising pane does not yet have.
    expect(ipc.watchSessionFile).toHaveBeenCalledTimes(1);
  });

  it("still releases a tail when the pane leaves the deck", async () => {
    // The pre-existing sweep must keep working: this is the only thing that
    // frees a native watcher for a pane that is closed outright.
    seed();
    await settle();

    act(() => deck.closeAgent("ws-1", "pane-1"));
    await settle();

    expect(ipc.unwatchSessionFile).toHaveBeenCalledWith("pane-1");
  });
});

describe("usage tails — a store search racing a binding", () => {
  // The lookup and the arm are two different claims on one pane, and they
  // were held in ONE set. A search that came back empty released the pane,
  // and a binding that had armed a real tail in the meantime lost it — the
  // native watcher was torn down within the same second it was built.
  // Measured live: a claude pane bound at 02:31:24, armed, unwatched
  // immediately, and then sat on "working" forever, because nothing was
  // reading the transcript where its interrupt marker was written.
  it("a lookup that finds nothing leaves the binding's tail alone", async () => {
    const store = createDeckStore();
    deck = createDeckActions(store);
    const attribution = createPaneAttribution({
      workspaces: () => store.getSnapshot().workspaces,
      secretOf: () => specs.token ?? undefined,
      swapSources: () => ["resume", "clear", "compact", "fork"],
    });

    let announce: ((bound: AcceptedBinding) => void) | null = null;
    let answerLookup: ((path: string | null) => void) | null = null;

    const lane = createUsageTailsLane({
      deck: store,
      attribution,
      bindings: {
        subscribe: (listener) => {
          announce = listener;
          return () => {};
        },
      },
      // The search hangs until the test lets it answer — that gap is where
      // the binding lands.
      tailOf: () =>
        dialectOf(
          [],
          () =>
            new Promise((resolve) => {
              answerLookup = (path) => resolve(path ? { path } : null);
            }),
        ),
      companionOf: () => undefined,
      usage: createUsageManager(),
      sightings: createUsageSightings(),
      declarations: {
        current: () => usageByAgent,
        subscribe: () => () => {},
      },
    });

    try {
      seed();
      for (let i = 0; i < 4; i++) await act(async () => {});
      expect(answerLookup).not.toBeNull();

      // The binding arrives and arms a real tail — and the arm is still in
      // flight when the search answers. That order is the whole bug: the
      // arm's own settle step runs LAST, and it is the step that asks
      // whether this pane is still claimed.
      let finishArm: (() => void) | null = null;
      ipc.watchSessionFile.mockImplementationOnce(
        () => new Promise<void>((resolve) => (finishArm = () => resolve())),
      );
      await act(async () => {
        present(announce, "the announce hook")({
          paneId: "pane-1",
          sessionId: "ses-1",
          transcriptPath: "/x/rollout.jsonl",
          token: "token-1",
        });
      });
      for (let i = 0; i < 4; i++) await act(async () => {});
      expect(ipc.watchSessionFile).toHaveBeenCalled();
      ipc.unwatchSessionFile.mockClear();

      // The search admits it found nothing, THEN the arm completes.
      await act(async () => present(answerLookup, "the lookup answer hook")(null));
      for (let i = 0; i < 4; i++) await act(async () => {});
      await act(async () => present(finishArm, "the arm finisher")());
      for (let i = 0; i < 4; i++) await act(async () => {});

      expect(ipc.unwatchSessionFile).not.toHaveBeenCalled();
    } finally {
      lane.dispose();
    }
  });
});

describe("usage tails — a pane whose process has a companion", () => {
  const USAGE_WATCH: TailWatch = {
    lane: "usage",
    match: [{ key: "type", equals: "assistant" }],
    keep: [],
  };
  const STATUS_WATCH: TailWatch = { lane: "status", match: [{ key: "type", equals: "user" }], keep: [] };
  const claudeUsage = new Map<string, AgentUsage>([
    ["claude", { normalize: () => null, tail: { watches: [USAGE_WATCH] } }],
  ]);

  function setup(covers: readonly CompanionCover[] | null) {
    const store = createDeckStore();
    deck = createDeckActions(store);
    const attribution = createPaneAttribution({
      workspaces: () => store.getSnapshot().workspaces,
      secretOf: () => "token-1",
      swapSources: () => ["resume", "clear", "compact", "fork"],
    });
    let announce!: (bound: AcceptedBinding) => void;
    const lane = createUsageTailsLane({
      deck: store,
      attribution,
      bindings: {
        subscribe: (listener) => {
          announce = listener;
          return () => {};
        },
      },
      tailOf: () => dialectOf([STATUS_WATCH], async () => null),
      companionOf: () => (covers ? { covers } : undefined),
      usage: createUsageManager(),
      sightings: createUsageSightings(),
      declarations: { current: () => claudeUsage, subscribe: () => () => {} },
    });
    act(() => {
      deck.createWorkspace({
        id: "ws-1",
        instance: createWorkspaceInstance(),
        name: "ws",
        cwd: "/repo",
        worktreeBaseDir: null,
        panes: [{ id: "pane-1", agentType: "claude" }],
      });
    });
    const bind = async () => {
      await act(async () =>
        announce({ paneId: "pane-1", sessionId: "ses-1", transcriptPath: "/p/s.jsonl", token: "token-1" }),
      );
      for (let i = 0; i < 4; i++) await act(async () => {});
    };
    const settle = async () => {
      for (let i = 0; i < 4; i++) await act(async () => {});
    };
    return { attribution, lane, bind, settle };
  }
  /** The watches the last arm carried. */
  const lastWatches = () => {
    const calls = ipc.watchSessionFile.mock.calls;
    return calls[calls.length - 1]?.[1].watches;
  };

  beforeEach(() => {
    ipc.watchSessionFile.mockClear();
    ipc.unwatchSessionFile.mockClear();
    ipc.retargetSessionFile.mockReset().mockResolvedValue(true);
  });

  it("reads the status records until the pinned process says hello, then only usage — without a re-read", async () => {
    const { attribution, lane, bind, settle } = setup(["status-records"]);
    try {
      attribution.recordBinding("pane-1", "100");
      await bind();
      expect(lastWatches()).toEqual([USAGE_WATCH, STATUS_WATCH]);

      attribution.recordCompanion("pane-1", "100");
      await settle();
      // The live tail narrows where it stands; the store is not read again.
      expect(ipc.retargetSessionFile).toHaveBeenCalledWith("pane-1", [USAGE_WATCH]);
      expect(ipc.unwatchSessionFile).not.toHaveBeenCalled();
      expect(ipc.watchSessionFile).toHaveBeenCalledTimes(1);

      // The same hello again changes nothing.
      attribution.recordCompanion("pane-1", "100");
      await settle();
      expect(ipc.retargetSessionFile).toHaveBeenCalledTimes(1);
      expect(ipc.watchSessionFile).toHaveBeenCalledTimes(1);
    } finally {
      lane.dispose();
    }
  });

  it("narrows a tail whose arm is still draining once it lands, without arming again", async () => {
    const { attribution, lane, bind, settle } = setup(["status-records"]);
    let land: () => void = () => {};
    ipc.watchSessionFile.mockImplementationOnce(
      () => new Promise<void>((resolve) => (land = resolve)),
    );
    try {
      attribution.recordBinding("pane-1", "100");
      await bind();
      // The hello arrives while the first arm is still reading the store.
      attribution.recordCompanion("pane-1", "100");
      await settle();
      expect(ipc.retargetSessionFile).not.toHaveBeenCalled();

      land();
      await settle();
      expect(ipc.retargetSessionFile).toHaveBeenCalledWith("pane-1", [USAGE_WATCH]);
      expect(ipc.watchSessionFile).toHaveBeenCalledTimes(1);
      expect(ipc.unwatchSessionFile).not.toHaveBeenCalled();
    } finally {
      lane.dispose();
    }
  });

  it("arms afresh when the tail cannot narrow where it stands", async () => {
    const { attribution, lane, bind, settle } = setup(["status-records"]);
    ipc.retargetSessionFile.mockResolvedValue(false);
    try {
      attribution.recordBinding("pane-1", "100");
      await bind();
      attribution.recordCompanion("pane-1", "100");
      await settle();
      expect(ipc.unwatchSessionFile).toHaveBeenCalledWith("pane-1");
      expect(ipc.watchSessionFile).toHaveBeenCalledTimes(2);
      expect(lastWatches()).toEqual([USAGE_WATCH]);
    } finally {
      lane.dispose();
    }
  });

  it("a hello before the binding arms usage records only, from the start", async () => {
    const { attribution, lane, bind } = setup(["status-records"]);
    try {
      attribution.recordBinding("pane-1", "100");
      attribution.recordCompanion("pane-1", "100");
      await bind();
      expect(ipc.watchSessionFile).toHaveBeenCalledTimes(1);
      expect(lastWatches()).toEqual([USAGE_WATCH]);
    } finally {
      lane.dispose();
    }
  });

  it("a hello from another process, or for an agent that declares no cover, reads everything", async () => {
    for (const [covers, helloFrom] of [
      [["status-records"], "200"],
      [null, "100"],
    ] as const) {
      ipc.watchSessionFile.mockClear();
      const { attribution, lane, bind, settle } = setup(covers);
      try {
        attribution.recordBinding("pane-1", "100");
        attribution.recordCompanion("pane-1", helloFrom);
        await bind();
        await settle();
        expect(ipc.watchSessionFile).toHaveBeenCalledTimes(1);
        expect(lastWatches()).toEqual([USAGE_WATCH, STATUS_WATCH]);
      } finally {
        lane.dispose();
      }
    }
  });

  it("a retired process gives the status records back to the store", async () => {
    const { attribution, lane, bind, settle } = setup(["status-records"]);
    try {
      attribution.recordBinding("pane-1", "100");
      attribution.recordCompanion("pane-1", "100");
      await bind();
      expect(lastWatches()).toEqual([USAGE_WATCH]);
      attribution.retire("pane-1");
      await settle();
      // Re-read, not narrowed: the store's latest turn edges are owed now.
      expect(ipc.retargetSessionFile).not.toHaveBeenCalled();
      expect(ipc.unwatchSessionFile).toHaveBeenCalledWith("pane-1");
      expect(lastWatches()).toEqual([USAGE_WATCH, STATUS_WATCH]);
    } finally {
      lane.dispose();
    }
  });
});

describe("usage tails — the booking horizon and the stores a pane names", () => {
  const codexUsage = (locate: (id: string) => Promise<string | null>) =>
    new Map<string, AgentUsage>([
      ["codex", { normalize: () => null, tail: { watches: [], locate } }],
    ]);

  function setup(locate: (id: string) => Promise<string | null> = async (id) => `/threads/${id}.jsonl`) {
    const store = createDeckStore();
    deck = createDeckActions(store);
    let announce!: (bound: AcceptedBinding) => void;
    const lane = createUsageTailsLane({
      deck: store,
      attribution: createPaneAttribution({
        workspaces: () => store.getSnapshot().workspaces,
        secretOf: () => "token-1",
        swapSources: () => [],
      }),
      bindings: {
        subscribe: (listener) => {
          announce = listener;
          return () => {};
        },
      },
      tailOf: () => dialectOf([], async () => null),
      companionOf: () => undefined,
      usage: createUsageManager(),
      sightings: createUsageSightings(() => 5_000),
      declarations: { current: () => codexUsage(locate), subscribe: () => () => {} },
    });
    act(() => {
      deck.createWorkspace({
        id: "ws-1",
        instance: createWorkspaceInstance(),
        name: "ws",
        cwd: "/repo",
        worktreeBaseDir: null,
        panes: [{ id: "pane-1", agentType: "codex" }],
      });
    });
    const settle = async () => {
      for (let i = 0; i < 6; i++) await act(async () => {});
    };
    const bind = async () => {
      await act(async () =>
        announce({ paneId: "pane-1", sessionId: "ses-1", transcriptPath: "/p/root.jsonl", token: "token-1" }),
      );
      await settle();
    };
    return { lane, bind, settle };
  }

  beforeEach(() => {
    ipc.watchSessionFile.mockReset().mockResolvedValue(undefined);
    ipc.unwatchSessionFile.mockClear();
    ipc.linkSessionFile.mockReset().mockResolvedValue(true);
    ipc.usageSince.mockReset().mockResolvedValue(7_000);
  });

  it("reads the store again only from where the ledger has not booked the session", async () => {
    const { lane, bind } = setup();
    try {
      await bind();
      // Asked with the instant this run first saw the session.
      expect(ipc.usageSince).toHaveBeenCalledWith("codex", "ses-1", 5_000);
      // Armed for the session the binding named, from the ledger's horizon.
      expect(ipc.watchSessionFile.mock.calls[0]?.[1]).toMatchObject({ session: "ses-1", since: 7_000 });
    } finally {
      lane.dispose();
    }
  });

  it("reads the whole store when the ledger cannot say — it books each call once anyway", async () => {
    ipc.usageSince.mockRejectedValue(new Error("store busy"));
    const { lane, bind } = setup();
    try {
      await bind();
      expect(ipc.watchSessionFile).toHaveBeenCalledTimes(1);
      expect(ipc.watchSessionFile.mock.calls[0]?.[1].since).toBeNull();
    } finally {
      lane.dispose();
    }
  });

  it("follows each named store once, where the agent locates it", async () => {
    const locate = vi.fn(async (id: string) => `/threads/${id}.jsonl`);
    const { lane, bind, settle } = setup(locate);
    try {
      await bind();
      lane.link("pane-1", ["t-2", "t-3"]);
      lane.link("pane-1", ["t-2"]);
      await settle();
      expect(locate.mock.calls.map(([id]) => id)).toEqual(["t-2", "t-3"]);
      expect(ipc.linkSessionFile.mock.calls).toEqual([
        ["pane-1", "/threads/t-2.jsonl"],
        ["pane-1", "/threads/t-3.jsonl"],
      ]);
    } finally {
      lane.dispose();
    }
  });

  it("links a store named while the arm still drains once the tail is there", async () => {
    let land: () => void = () => {};
    ipc.watchSessionFile.mockImplementationOnce(
      () => new Promise<void>((resolve) => (land = resolve)),
    );
    const { lane, bind, settle } = setup();
    try {
      await bind();
      lane.link("pane-1", ["t-2"]);
      await settle();
      expect(ipc.linkSessionFile).not.toHaveBeenCalled();

      land();
      await settle();
      expect(ipc.linkSessionFile).toHaveBeenCalledWith("pane-1", "/threads/t-2.jsonl");
    } finally {
      lane.dispose();
    }
  });

  it("tries a store again when it was not found or not linked", async () => {
    const locate = vi.fn<(id: string) => Promise<string | null>>().mockResolvedValueOnce(null);
    locate.mockImplementation(async (id) => `/threads/${id}.jsonl`);
    const { lane, bind, settle } = setup(locate);
    try {
      await bind();
      lane.link("pane-1", ["t-2"]);
      await settle();
      expect(ipc.linkSessionFile).not.toHaveBeenCalled();

      ipc.linkSessionFile.mockResolvedValueOnce(false);
      lane.link("pane-1", ["t-2"]);
      await settle();
      lane.link("pane-1", ["t-2"]);
      await settle();
      expect(ipc.linkSessionFile).toHaveBeenCalledTimes(2);
      lane.link("pane-1", ["t-2"]);
      await settle();
      expect(ipc.linkSessionFile).toHaveBeenCalledTimes(2);
    } finally {
      lane.dispose();
    }
  });

  it("names nothing for a pane it does not tail", async () => {
    const locate = vi.fn(async () => "/x.jsonl");
    const { lane, settle } = setup(locate);
    try {
      lane.link("pane-1", ["t-2"]);
      await settle();
      expect(locate).not.toHaveBeenCalled();
      expect(ipc.linkSessionFile).not.toHaveBeenCalled();
    } finally {
      lane.dispose();
    }
  });
});
