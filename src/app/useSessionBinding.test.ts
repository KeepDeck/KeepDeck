// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Deck } from "./useDeck";

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

import { postbackAccepted, useSessionBinding } from "./useSessionBinding";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

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

describe("useSessionBinding", () => {
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
    document.body.innerHTML = "<div id='host'></div>";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  const mount = async (sessionId?: string) => {
    const setPaneSession = vi.fn();
    const deck = {
      workspaces: [
        {
          id: "ws-1",
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
      setPaneSession,
    } as unknown as Deck;
    const Probe = () => {
      useSessionBinding(deck);
      return null;
    };
    const root = createRoot(document.getElementById("host")!);
    await act(async () => root.render(createElement(Probe)));
    return { root, setPaneSession };
  };

  it("clears pane telemetry before binding a different session", async () => {
    const { root, setPaneSession } = await mount("session-old");

    act(() => emit({ paneId: "pane-1", sessionId: "session-new", token: "tok" }));

    expect(bridge.beginPaneUsageSession).toHaveBeenCalledWith(
      "pane-1",
      "session-new",
    );
    expect(bridge.bindPaneSpawnSpecSession).toHaveBeenCalledWith(
      "pane-1",
      "session-new",
    );
    expect(setPaneSession).toHaveBeenCalledWith(
      "ws-1",
      "pane-1",
      expect.objectContaining({ id: "session-new" }),
      undefined,
    );
    act(() => root.unmount());
  });

  it("keeps telemetry on the initial and same-session bindings", async () => {
    let mounted = await mount();
    act(() => emit({ paneId: "pane-1", sessionId: "session-1", token: "tok" }));
    expect(bridge.beginPaneUsageSession).not.toHaveBeenCalled();
    act(() => mounted.root.unmount());

    document.body.innerHTML = "<div id='host'></div>";
    mounted = await mount("session-1");
    act(() => emit({ paneId: "pane-1", sessionId: "session-1", token: "tok" }));
    expect(bridge.beginPaneUsageSession).not.toHaveBeenCalled();
    act(() => mounted.root.unmount());
  });

  it("does not bind a session for a REMOTE pane (fresh-session only)", async () => {
    // A remote pane's local thin-client reporter fires too — but binding it
    // would let a revive/restart resume LOCALLY against a VPS-only session id.
    // The postback is still counted; only the binding is skipped.
    const setPaneSession = vi.fn();
    const deck = {
      workspaces: [
        {
          id: "ws-1",
          panes: [{ id: "pane-1", remoteEndpoint: "ws://vps:4500" }],
        },
      ],
      setPaneSession,
    } as unknown as Deck;
    const Probe = () => {
      useSessionBinding(deck);
      return null;
    };
    const root = createRoot(document.getElementById("host")!);
    await act(async () => root.render(createElement(Probe)));

    act(() => emit({ paneId: "pane-1", sessionId: "ses-1", token: "tok" }));

    expect(bridge.bumpPostback).toHaveBeenCalledWith("pane-1");
    expect(bridge.bindPaneSpawnSpecSession).not.toHaveBeenCalled();
    expect(setPaneSession).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
