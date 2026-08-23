import { describe, expect, it, vi } from "vitest";
import { createArtifactsPolicy } from "./policy";

/** A settings double: the value, flipped by test, notifying listeners. */
function settingsPort(initial: boolean | null) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    artifacts: () => value,
    set(next: boolean | null) {
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Transport doubles injected THROUGH THE CONSTRUCTOR — no module mock,
 * no production test seam (the McpTransportPort pattern). */
function transport(port = 43119) {
  const calls: string[] = [];
  return {
    calls,
    enable: vi.fn(async () => {
      calls.push("enable");
      return port;
    }),
    disable: vi.fn(async () => {
      calls.push("disable");
    }),
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createArtifactsPolicy", () => {
  it("boot-reconciles the loaded setting (enable on a settled true)", async () => {
    const t = transport();
    const settings = settingsPort(true);
    const transitions: unknown[] = [];
    createArtifactsPolicy(settings, t, (tr) => transitions.push(tr));
    await flush();
    expect(t.calls).toEqual(["enable"]);
    expect(transitions).toEqual([
      { desired: true, ok: true, detail: "display server on port 43119" },
    ]);
  });

  it("an honest port 0 (server not yet attached) reports no port clause", async () => {
    const t = transport(0);
    const settings = settingsPort(true);
    const transitions: unknown[] = [];
    createArtifactsPolicy(settings, t, (tr) => transitions.push(tr));
    await flush();
    expect(transitions).toEqual([{ desired: true, ok: true, detail: null }]);
  });

  it("no-ops while the settings load is unsettled (null = unknown)", async () => {
    const t = transport();
    const settings = settingsPort(null);
    createArtifactsPolicy(settings, t, () => {});
    await flush();
    expect(t.calls).toEqual([]);
  });

  it("a toggle flip drives the matching call; a fast On→Off serializes", async () => {
    const t = transport();
    const settings = settingsPort(false);
    createArtifactsPolicy(settings, t, () => {});
    await flush();
    expect(t.calls).toEqual(["disable"]);

    settings.set(true);
    settings.set(false);
    await flush();
    // enable-then-disable, never interleaved — the chain's whole point.
    expect(t.calls).toEqual(["disable", "enable", "disable"]);
  });

  it("a failed enable reports and retries on the next settings event", async () => {
    const t = transport();
    const settings = settingsPort(true);
    const transitions: unknown[] = [];
    // The thrown enable records nothing in `calls` (throw beats push) —
    // the transitions array is the assertion for the failure itself.
    t.enable.mockImplementationOnce(async () => {
      throw "artifact store is owned by another KeepDeck process";
    });
    createArtifactsPolicy(settings, t, (tr) => transitions.push(tr));
    await flush();
    expect(transitions).toEqual([
      {
        desired: true,
        ok: false,
        detail: "artifact store is owned by another KeepDeck process",
      },
    ]);
    // The applied mark cleared → the next event retries: Off then On.
    settings.set(false);
    await flush();
    settings.set(true);
    await flush();
    expect(t.calls).toEqual(["disable", "enable"]);
  });

  // THE LIFETIME PIN. Dispose runs from `beforeunload`, which fires on
  // every window reload — an HMR reload in dev, a Cmd+R, a devtools
  // reload — while the Rust process it would tear down is untouched.
  // Disabling here killed a live display server, said goodbye to every
  // open tab, and rebound on a fresh ephemeral port, so every url already
  // printed into scrollback died with it. A real process exit needs no
  // help: the store claim is an flock the kernel releases.
  it("dispose NEVER disables — the server outlives the page", async () => {
    const t = transport();
    const settings = settingsPort(true);
    const policy = createArtifactsPolicy(settings, t, () => {});
    await flush();
    policy.dispose();
    await flush();
    await flush(); // anything queued would have settled by now
    expect(t.calls).toEqual(["enable"]);
  });

  it("dispose stops reconciling — later settings events do nothing", async () => {
    const t = transport();
    const settings = settingsPort(true);
    const policy = createArtifactsPolicy(settings, t, () => {});
    await flush();
    policy.dispose();
    settings.set(false);
    await flush();
    expect(t.calls).toEqual(["enable"]);
  });

  it("drops a late report after dispose", async () => {
    let releaseEnable!: (port: number) => void;
    const enable = vi.fn(
      () => new Promise<number>((resolve) => (releaseEnable = resolve)),
    );
    const disable = vi.fn(async () => {});
    const report = vi.fn();
    const settings = settingsPort(true);
    const policy = createArtifactsPolicy(settings, { enable, disable }, report);

    await flush(); // the enable is now in flight
    policy.dispose();
    releaseEnable(43119);
    await flush();
    await flush(); // anything queued would have settled by now

    expect(disable).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });
});
