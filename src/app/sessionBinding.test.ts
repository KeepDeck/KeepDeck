import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckStore } from "./deckStore";
import type { SessionBound } from "../ipc/sessions";

const bridge = vi.hoisted(() => ({
  onSessionBound: vi.fn(),
  peekPaneSpawnSpec: vi.fn(),
  bindPaneSpawnSpecSession: vi.fn(),
  bumpPostback: vi.fn(),
  beginSession: vi.fn(),
}));
vi.mock("../ipc/sessions", () => ({ onSessionBound: bridge.onSessionBound }));
vi.mock("./spawnSpecs", () => ({
  peekPaneSpawnSpec: bridge.peekPaneSpawnSpec,
  bindPaneSpawnSpecSession: bridge.bindPaneSpawnSpecSession,
}));
vi.mock("./postbacks", () => ({ bumpPostback: bridge.bumpPostback }));

/** A fake of the runtime's telemetry owner — the binding only begins
 * sessions; retiring belongs to the orchestrator's paths. */
const telemetry = { retire: vi.fn(), beginSession: bridge.beginSession };

import { createPaneAttribution } from "./paneAttribution";
import { createSessionBinding } from "./sessionBinding";

describe("createSessionBinding", () => {
  // Defaulted to a no-op so the shared `let` is never undefined across the
  // effect-flush race (a call before the handler registers is a silent no-op
  // rather than a cryptic TypeError flake).
  let emit: (event: SessionBound) => void = () => {};

  beforeEach(() => {
    bridge.beginSession.mockClear();
    bridge.bindPaneSpawnSpecSession.mockClear();
    bridge.bumpPostback.mockClear();
    bridge.peekPaneSpawnSpec.mockReturnValue({ token: "tok" });
    bridge.onSessionBound.mockImplementation((handler) => {
      emit = handler;
      return Promise.resolve(() => {});
    });
  });

  /** What the pane's own claude reports at startup. */
  const own = (over: Partial<SessionBound> = {}): SessionBound => ({
    paneId: "pane-1",
    sessionId: "session-new",
    token: "tok",
    agent: "claude",
    source: "startup",
    ...over,
  });

  const mount = (
    sessionId?: string,
    pane: Record<string, unknown> = { agentType: "claude" },
  ) => {
    const state = {
      workspaces: [
        {
          id: "ws-1",
          instance: "instance-1",
          name: "workspace",
          cwd: "/repo",
          worktreeBaseDir: null,
          panes: [
            {
              id: "pane-1",
              ...pane,
              ...(sessionId
                ? { session: { id: sessionId, boundAt: "2026-07-22T00:00:00Z" } }
                : {}),
            },
          ],
        },
      ],
      activeId: "ws-1",
      viewByWs: {},
      journal: { records: {}, tail: [] },
    };
    const dispatch = vi.fn(() => state);
    const store = {
      getSnapshot: () => state,
      subscribe: () => () => {},
      dispatch,
    } as unknown as DeckStore;
    // The REAL rule, over stub deps: a fake here would only assert that the
    // binding calls something, not that the rule it calls is the one shipping.
    const attribution = createPaneAttribution({
      workspaces: () => state.workspaces as never,
      secretOf: () => "tok",
    });
    return {
      binding: createSessionBinding(store, telemetry, attribution),
      dispatch,
      // Exposed for the one thing only the shared instance can show: that a
      // binding this lane accepted also opens the REPORT lanes, which read
      // their verdict from this same rule.
      attribution,
    };
  };

  it("clears pane telemetry before binding a different session", async () => {
    const { binding, dispatch } = mount("session-old");

    emit(own({ source: "clear" }));

    expect(bridge.beginSession).toHaveBeenCalledWith("pane-1", "session-new");
    expect(bridge.bindPaneSpawnSpecSession).toHaveBeenCalledWith(
      "pane-1",
      "session-new",
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "setPaneSession",
        wsId: "ws-1",
        paneId: "pane-1",
        session: expect.objectContaining({ id: "session-new" }),
      }),
    );
    binding.dispose();
  });

  it("re-reports the SAME session with the stamp it was first bound at", async () => {
    // These hooks fire again for every resume, /clear and compaction. A fresh
    // timestamp each time makes the journal record differ from itself, so the
    // dedupe misses and every one of them appends and fsyncs a `bound` event
    // and re-renders the deck. Nothing about the binding has changed.
    const { binding, dispatch } = mount("session-old");

    emit(own({ sessionId: "session-old", source: "resume" }));

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        session: {
          id: "session-old",
          boundAt: "2026-07-22T00:00:00Z",
        },
      }),
    );
    binding.dispose();
  });

  it("keeps telemetry on the initial and same-session bindings", async () => {
    let mounted = mount();
    emit(own({ sessionId: "session-1" }));
    expect(bridge.beginSession).not.toHaveBeenCalled();
    mounted.binding.dispose();

    mounted = mount("session-1");
    emit(own({ sessionId: "session-1", source: "resume" }));
    expect(bridge.beginSession).not.toHaveBeenCalled();
    mounted.binding.dispose();
  });

  it("refuses a SECOND fresh session in one process generation", async () => {
    // The teammate case: a full, independent session of the same agent
    // starting up under the pane's inherited secret while the pane's own
    // session is already bound. Binding it would point the pane's resume at
    // a conversation the user never had.
    const { binding, dispatch } = mount();

    emit(own({ sessionId: "session-1" }));
    dispatch.mockClear();
    emit(own({ sessionId: "teammate-session" }));

    expect(dispatch).not.toHaveBeenCalled();
    expect(bridge.bindPaneSpawnSpecSession).not.toHaveBeenCalledWith(
      "pane-1",
      "teammate-session",
    );
    binding.dispose();
  });

  it("follows a fork into the process claude re-hosts the session in", async () => {
    // The field case: at a full context window claude forks the conversation
    // into a daemon-hosted process, so the binding AND every later report
    // arrive from a new process group. Both have to land — a binding accepted
    // while the report lanes stay pinned to the process it left leaves the
    // pane with a current identity and frozen usage and status.
    const { binding, dispatch, attribution } = mount("session-old");

    emit(own({ sessionId: "session-old", reporter: "22422" }));
    expect(attribution.admitsReport("pane-1", "tok", "claude", "22422")).toBe(
      true,
    );
    dispatch.mockClear();

    emit(own({ sessionId: "session-forked", source: "fork", reporter: "920" }));

    expect(bridge.beginSession).toHaveBeenCalledWith("pane-1", "session-forked");
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "setPaneSession",
        session: expect.objectContaining({ id: "session-forked" }),
      }),
    );
    expect(attribution.admitsReport("pane-1", "tok", "claude", "920")).toBe(
      true,
    );
    // And the process it left speaks for this pane no longer.
    expect(attribution.admitsReport("pane-1", "tok", "claude", "22422")).toBe(
      false,
    );
    binding.dispose();
  });

  it("refuses a foreign agent on its very first report", async () => {
    // `kimi` run from a tool call inside a claude pane: nothing has bound
    // yet, so only the agent rule can catch it.
    const { binding, dispatch } = mount();

    emit(own({ agent: "kimi", sessionId: "session_kimi" }));

    expect(dispatch).not.toHaveBeenCalled();
    expect(bridge.bumpPostback).not.toHaveBeenCalled();
    binding.dispose();
  });

  it("does not bind a session for a REMOTE pane (fresh-session only)", async () => {
    // A remote pane's local thin-client reporter fires too — but binding it
    // would let a revive/restart resume LOCALLY against a VPS-only session id.
    // The postback is still counted; only the binding is skipped.
    const { binding, dispatch } = mount(undefined, {
      agentType: "claude",
      location: { kind: "remote", endpoint: "ws://vps:4500" },
    });

    emit(own({ sessionId: "ses-1" }));

    expect(bridge.bumpPostback).toHaveBeenCalledWith("pane-1");
    expect(bridge.bindPaneSpawnSpecSession).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    binding.dispose();
  });
});
