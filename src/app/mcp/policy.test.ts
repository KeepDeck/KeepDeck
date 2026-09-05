import { describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/log", () => ({
  log: { warn: vi.fn() },
  describeError: (e: unknown) => String(e),
}));

import { createMcpServerPolicy, type McpTransportPort } from "./policy";

function transportPort() {
  const enable = vi.fn(() => Promise.resolve("/sock"));
  const disable = vi.fn(() => Promise.resolve());
  const transport: McpTransportPort = { enable, disable };
  return { transport, enable, disable };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createMcpServerPolicy", () => {
  it("enables as soon as it exists — there is no setting to wait for", async () => {
    const { transport, enable, disable } = transportPort();
    createMcpServerPolicy(transport, () => {});
    await flush();
    expect(enable).toHaveBeenCalledTimes(1);
    expect(disable).not.toHaveBeenCalled();
  });

  it("ensure is a no-op while the enable is in flight or confirmed", async () => {
    let release!: () => void;
    const enable = vi.fn(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const policy = createMcpServerPolicy(
      { enable, disable: vi.fn(() => Promise.resolve()) },
      () => {},
    );
    policy.ensure(); // in flight
    await flush();
    expect(enable).toHaveBeenCalledTimes(1);
    release();
    await flush();
    policy.ensure(); // confirmed
    await flush();
    expect(enable).toHaveBeenCalledTimes(1);
  });

  it("retries on ensure after a failed enable", async () => {
    const enable = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("no home"))
      .mockResolvedValue("/sock");
    const policy = createMcpServerPolicy(
      { enable, disable: vi.fn(() => Promise.resolve()) },
      () => {},
    );
    await flush();
    expect(enable).toHaveBeenCalledTimes(1);
    // The failure cleared the applied mark, so the policy tries again rather
    // than trusting a state the backend never confirmed.
    policy.ensure();
    await flush();
    expect(enable).toHaveBeenCalledTimes(2);
  });

  it("reports each settled enable to the given sink", async () => {
    const transitions: unknown[] = [];
    const enable = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("taken"))
      .mockResolvedValueOnce("/sock");
    const policy = createMcpServerPolicy(
      { enable, disable: vi.fn(() => Promise.resolve()) },
      (t) => transitions.push(t),
    );
    await flush();
    policy.ensure();
    await flush();
    expect(transitions).toEqual([
      // detail carries this file's describeError mock rendering.
      { ok: false, detail: "Error: taken" },
      { ok: true, detail: "/sock" },
    ]);
  });

  it("a confirmation without a path is reported as such, not as a socket", async () => {
    const transitions: unknown[] = [];
    createMcpServerPolicy(
      {
        enable: vi.fn(() => Promise.resolve(undefined)),
        disable: vi.fn(() => Promise.resolve()),
      },
      (t) => transitions.push(t),
    );
    await flush();
    expect(transitions).toEqual([{ ok: true, detail: null }]);
  });

  it("ensure after dispose enables nothing — dispose is final", async () => {
    const enable = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("taken"))
      .mockResolvedValue("/sock");
    const policy = createMcpServerPolicy(
      { enable, disable: vi.fn(() => Promise.resolve()) },
      () => {},
    );
    await flush(); // the first enable failed: a retry WOULD be due
    policy.dispose({ disable: true });
    policy.ensure();
    await flush();
    expect(enable).toHaveBeenCalledTimes(1);
  });

  it("dispose({disable}) queues the final disable BEHIND an in-flight enable", async () => {
    let releaseEnable!: () => void;
    const enable = vi.fn(
      () => new Promise<void>((resolve) => (releaseEnable = resolve)),
    );
    const disable = vi.fn(() => Promise.resolve());
    const policy = createMcpServerPolicy({ enable, disable }, () => {});
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

  it("dispose without the option leaves the socket alone", async () => {
    const { transport, disable } = transportPort();
    const policy = createMcpServerPolicy(transport, () => {});
    await flush();
    policy.dispose();
    await flush();
    expect(disable).not.toHaveBeenCalled();
  });
});
