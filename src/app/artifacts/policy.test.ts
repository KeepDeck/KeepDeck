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

/** IPC doubles: recording transports the policy drives. */
function transport() {
  const calls: string[] = [];
  const enable = vi.fn(async () => {
    calls.push("enable");
    return 43119;
  });
  const disable = vi.fn(async () => {
    calls.push("disable");
  });
  return { calls, enable, disable };
}

vi.mock("../../ipc/artifacts", () => {
  const t = transport();
  return {
    artifactsEnable: t.enable,
    artifactsDisable: t.disable,
    __testTransport: t,
  };
});

// The policy imports the module bindings; re-import after the mock to
// hand the SAME doubles to the test.
import { __testTransport } from "../../ipc/artifacts";

const __t = __testTransport as ReturnType<typeof transport>;

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createArtifactsPolicy", () => {
  it("boot-reconciles the loaded setting (enable on a settled true)", async () => {
    __t.calls.length = 0;
    const settings = settingsPort(true);
    const transitions: unknown[] = [];
    createArtifactsPolicy(settings, (t) => transitions.push(t));
    await flush();
    expect(__t.calls).toEqual(["enable"]);
    expect(transitions).toEqual([
      { desired: true, ok: true, detail: "display server on port 43119" },
    ]);
  });

  it("no-ops while the settings load is unsettled (null = unknown)", async () => {
    __t.calls.length = 0;
    const settings = settingsPort(null);
    createArtifactsPolicy(settings, () => {});
    await flush();
    expect(__t.calls).toEqual([]);
  });

  it("a toggle flip drives the matching call; a fast On→Off serializes", async () => {
    __t.calls.length = 0;
    const settings = settingsPort(false);
    createArtifactsPolicy(settings, () => {});
    await flush();
    expect(__t.calls).toEqual(["disable"]);

    settings.set(true);
    settings.set(false);
    await flush();
    // enable-then-disable, never interleaved — the chain's whole point.
    expect(__t.calls).toEqual(["disable", "enable", "disable"]);
  });

  it("a failed enable reports and retries on the next settings event", async () => {
    __t.calls.length = 0;
    const settings = settingsPort(true);
    const transitions: unknown[] = [];
    const first = __t.enable.mockImplementationOnce(async () => {
      throw "artifact store is owned by another KeepDeck process";
    });
    createArtifactsPolicy(settings, (t) => transitions.push(t));
    await flush();
    expect(first).toHaveBeenCalled();
    expect(transitions).toEqual([
      {
        desired: true,
        ok: false,
        detail: "artifact store is owned by another KeepDeck process",
      },
    ]);
    // The FIRST enable threw before recording its call in `calls` — the
    // double's record and the throw are one statement, so the throw wins.
    // From here the applied mark is cleared → the next event retries.

    // Flip Off then On: the retry path.
    settings.set(false);
    await flush();
    settings.set(true);
    await flush();
    expect(__t.calls).toEqual(["disable", "enable"]);
  });

  it("dispose({disable}) queues a final disable behind an in-flight enable", async () => {
    __t.calls.length = 0;
    const settings = settingsPort(true);
    const policy = createArtifactsPolicy(settings, () => {});
    policy.dispose({ disable: true });
    await flush();
    expect(__t.calls).toEqual(["enable", "disable"]);
  });

  it("dispose stops reconciling — later settings events do nothing", async () => {
    __t.calls.length = 0;
    const settings = settingsPort(true);
    const policy = createArtifactsPolicy(settings, () => {});
    await flush();
    policy.dispose();
    settings.set(false);
    await flush();
    expect(__t.calls).toEqual(["enable"]);
  });
});
