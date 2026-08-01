import { describe, expect, it, vi } from "vitest";

vi.mock("../ipc/log", () => ({
  log: { warn: vi.fn() },
  describeError: (e: unknown) => String(e),
}));

import {
  createMcpServerPolicy,
  type McpSettingsPort,
  type McpTransportPort,
} from "./mcpServerPolicy";

function settingsPort(initial: boolean | null) {
  let value = initial;
  const listeners = new Set<() => void>();
  const settings: McpSettingsPort = {
    mcpServer: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const set = (next: boolean | null) => {
    value = next;
    for (const listener of [...listeners]) listener();
  };
  return { settings, set };
}

function transportPort() {
  const enable = vi.fn(() => Promise.resolve("/sock"));
  const disable = vi.fn(() => Promise.resolve());
  const transport: McpTransportPort = { enable, disable };
  return { transport, enable, disable };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createMcpServerPolicy", () => {
  it("enables at boot when the setting is already on", async () => {
    const { settings } = settingsPort(true);
    const { transport, enable } = transportPort();
    createMcpServerPolicy(settings, transport, () => {});
    await flush();
    expect(enable).toHaveBeenCalledTimes(1);
  });

  it("does nothing before the settings load settles, then applies", async () => {
    const { settings, set } = settingsPort(null);
    const { transport, enable, disable } = transportPort();
    createMcpServerPolicy(settings, transport, () => {});
    await flush();
    expect(enable).not.toHaveBeenCalled();
    expect(disable).not.toHaveBeenCalled();
    set(true);
    await flush();
    expect(enable).toHaveBeenCalledTimes(1);
  });

  it("follows the toggle both ways and ignores same-value notifications", async () => {
    const { settings, set } = settingsPort(false);
    const { transport, enable, disable } = transportPort();
    createMcpServerPolicy(settings, transport, () => {});
    await flush();
    // Off at boot still reconciles: the backend's state is unknown to a
    // fresh webview (a reload may have left the socket up), and disable is
    // idempotent — so the policy asserts Off rather than assuming it.
    expect(disable).toHaveBeenCalledTimes(1);
    set(true);
    set(true);
    await flush();
    expect(enable).toHaveBeenCalledTimes(1);
    set(false);
    await flush();
    expect(disable).toHaveBeenCalledTimes(2);
  });

  it("serializes a fast On→Off flip as enable-then-disable", async () => {
    const { settings, set } = settingsPort(null);
    let releaseEnable!: () => void;
    const enable = vi.fn(
      () => new Promise<void>((resolve) => (releaseEnable = resolve)),
    );
    const disable = vi.fn(() => Promise.resolve());
    createMcpServerPolicy(settings, { enable, disable }, () => {});
    set(true);
    set(false);
    await flush();
    // The disable must WAIT for the in-flight enable — interleaving would
    // let the backend land in the wrong final state.
    expect(enable).toHaveBeenCalledTimes(1);
    expect(disable).not.toHaveBeenCalled();
    releaseEnable();
    await flush();
    expect(disable).toHaveBeenCalledTimes(1);
  });

  it("retries on the next event after a failed call", async () => {
    const { settings, set } = settingsPort(null);
    const enable = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("no home"))
      .mockResolvedValue("/sock");
    const disable = vi.fn(() => Promise.resolve());
    createMcpServerPolicy(settings, { enable, disable }, () => {});
    set(true);
    await flush();
    expect(enable).toHaveBeenCalledTimes(1);
    // Same value, new event: the failure cleared the applied mark, so the
    // policy tries again rather than trusting a state the backend never
    // confirmed.
    set(true);
    await flush();
    expect(enable).toHaveBeenCalledTimes(2);
  });

  it("an old call's failure cannot clear a mark newer events re-established", async () => {
    const { settings, set } = settingsPort(null);
    let failFirst!: (e: Error) => void;
    const enable = vi
      .fn<() => Promise<unknown>>()
      .mockImplementationOnce(
        () => new Promise((_resolve, reject) => (failFirst = reject)),
      )
      .mockResolvedValue("/sock");
    const disable = vi.fn(() => Promise.resolve());
    createMcpServerPolicy(settings, { enable, disable }, () => {});
    set(true); // enable#1, deferred
    set(false); // disable, queued
    set(true); // enable#2, queued
    await flush(); // let the chain reach enable#1 so failFirst exists
    failFirst(new Error("boom"));
    await flush();
    // The stale failure belongs to epoch 1; the mark belongs to epoch 3 —
    // a same-value event must NOT re-issue a third enable.
    set(true);
    await flush();
    expect(enable).toHaveBeenCalledTimes(2);
  });

  it("reports each settled transition to the given sink", async () => {
    const { settings, set } = settingsPort(null);
    const transitions: unknown[] = [];
    const enable = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce("/sock")
      .mockRejectedValueOnce(new Error("taken"));
    createMcpServerPolicy(
      settings,
      { enable, disable: vi.fn(() => Promise.resolve()) },
      (t) => transitions.push(t),
    );
    set(true);
    await flush();
    set(false);
    await flush();
    set(true); // this enable rejects
    await flush();
    expect(transitions).toEqual([
      { desired: true, ok: true, detail: "/sock" },
      { desired: false, ok: true, detail: null },
      // detail carries this file's describeError mock rendering.
      { desired: true, ok: false, detail: "Error: taken" },
    ]);
  });

  it("stops reacting after dispose", async () => {
    const { settings, set } = settingsPort(null);
    const { transport, enable } = transportPort();
    const policy = createMcpServerPolicy(settings, transport, () => {});
    policy.dispose();
    set(true);
    await flush();
    expect(enable).not.toHaveBeenCalled();
  });

  it("a settings notification that outlives dispose cannot re-enable", async () => {
    // A notifier iterating a SNAPSHOT of its listeners can still call a
    // listener disposed earlier in the same pass; queueing an enable then
    // would undo the final disable.
    let value: boolean | null = null;
    let notify!: () => void;
    const settings: McpSettingsPort = {
      mcpServer: () => value,
      subscribe(listener) {
        notify = listener;
        return () => {};
      },
    };
    const { transport, enable } = transportPort();
    const policy = createMcpServerPolicy(settings, transport, () => {});
    policy.dispose({ disable: true });
    value = true;
    notify();
    await flush();
    expect(enable).not.toHaveBeenCalled();
  });

  it("dispose({disable}) queues the final disable BEHIND an in-flight enable", async () => {
    const { settings, set } = settingsPort(null);
    let releaseEnable!: () => void;
    const enable = vi.fn(
      () => new Promise<void>((resolve) => (releaseEnable = resolve)),
    );
    const disable = vi.fn(() => Promise.resolve());
    const policy = createMcpServerPolicy(settings, { enable, disable }, () => {});
    set(true);
    await flush(); // the enable is now in flight
    policy.dispose({ disable: true });
    await flush();
    // Off-chain, the disable could overtake the enable and the socket would
    // come back up after the page died — the chain forbids exactly that.
    expect(disable).not.toHaveBeenCalled();
    releaseEnable();
    await flush();
    expect(disable).toHaveBeenCalledTimes(1);
  });
});
