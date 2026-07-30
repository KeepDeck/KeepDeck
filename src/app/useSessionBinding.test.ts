import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckStore } from "./deckStore";

const bridge = vi.hoisted(() => ({
  onSessionBound: vi.fn(),
  peekPaneSpawnSpec: vi.fn(),
  bindPaneSpawnSpecSession: vi.fn(),
  bumpPostback: vi.fn(),
  beginPaneUsageSession: vi.fn(),
}));
vi.mock("../ipc/sessions", () => ({ onSessionBound: bridge.onSessionBound }));
vi.mock("./spawnSpecs", () => ({
  peekPaneSpawnSpec: bridge.peekPaneSpawnSpec,
  bindPaneSpawnSpecSession: bridge.bindPaneSpawnSpecSession,
}));
vi.mock("./postbacks", () => ({ bumpPostback: bridge.bumpPostback }));
vi.mock("./usageManager", () => ({
  beginPaneUsageSession: bridge.beginPaneUsageSession,
}));

import {
  createSessionBinding,
  postbackAccepted,
} from "./sessionBinding";

// The bridge's anti-forgery rule: an inbox postback binds a pane only when
// it echoes the per-spawn secret. Writing a file is not enough.
describe("postbackAccepted", () => {
  it("accepts only the exact token the pane's spawn carried", () => {
    expect(postbackAccepted({ token: "tok" }, "tok")).toBe(true);
    expect(postbackAccepted({ token: "tok" }, "forged")).toBe(false);
  });

  it("a pane that armed no reporter accepts nothing", () => {
    // No cached spec at all (unknown pane, or postback outlived the pane).
    expect(postbackAccepted(undefined, "tok")).toBe(false);
    // A spec without a token (bridge was down at spawn) — nothing could
    // legitimately post back, so nothing may bind.
    expect(postbackAccepted({}, "tok")).toBe(false);
    expect(postbackAccepted({ token: "" }, "")).toBe(false);
  });
});

describe("createSessionBinding", () => {
  // Defaulted to a no-op so the shared `let` is never undefined across the
  // effect-flush race (a call before the handler registers is a silent no-op
  // rather than a cryptic TypeError flake).
  let emit: (event: {
    paneId: string;
    sessionId: string;
    token: string;
    transcriptPath?: string;
  }) => void = () => {};

  beforeEach(() => {
    bridge.beginPaneUsageSession.mockClear();
    bridge.bindPaneSpawnSpecSession.mockClear();
    bridge.bumpPostback.mockClear();
    bridge.peekPaneSpawnSpec.mockReturnValue({ token: "tok" });
    bridge.onSessionBound.mockImplementation((handler) => {
      emit = handler;
      return Promise.resolve(() => {});
    });
  });

  const mount = (sessionId?: string) => {
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
    return { binding: createSessionBinding(store), dispatch };
  };

  it("clears pane telemetry before binding a different session", async () => {
    const { binding, dispatch } = mount("session-old");

    emit({ paneId: "pane-1", sessionId: "session-new", token: "tok" });

    expect(bridge.beginPaneUsageSession).toHaveBeenCalledWith(
      "pane-1",
      "session-new",
    );
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

    emit({ paneId: "pane-1", sessionId: "session-old", token: "tok" });

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
    emit({ paneId: "pane-1", sessionId: "session-1", token: "tok" });
    expect(bridge.beginPaneUsageSession).not.toHaveBeenCalled();
    mounted.binding.dispose();

    mounted = mount("session-1");
    emit({ paneId: "pane-1", sessionId: "session-1", token: "tok" });
    expect(bridge.beginPaneUsageSession).not.toHaveBeenCalled();
    mounted.binding.dispose();
  });

  it("does not bind a session for a REMOTE pane (fresh-session only)", async () => {
    // A remote pane's local thin-client reporter fires too — but binding it
    // would let a revive/restart resume LOCALLY against a VPS-only session id.
    // The postback is still counted; only the binding is skipped.
    const state = {
      workspaces: [
        {
          id: "ws-1",
          instance: "instance-1",
          name: "workspace",
          cwd: "/repo",
          worktreeBaseDir: null,
          panes: [{ id: "pane-1", remoteEndpoint: "ws://vps:4500" }],
        },
      ],
      activeId: "ws-1",
      viewByWs: {},
      journal: { records: {}, tail: [] },
    };
    const dispatch = vi.fn(() => state);
    const binding = createSessionBinding({
      getSnapshot: () => state,
      subscribe: () => () => {},
      dispatch,
    } as unknown as DeckStore);

    emit({ paneId: "pane-1", sessionId: "ses-1", token: "tok" });

    expect(bridge.bumpPostback).toHaveBeenCalledWith("pane-1");
    expect(bridge.bindPaneSpawnSpecSession).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    binding.dispose();
  });
});
