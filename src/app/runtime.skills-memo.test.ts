/**
 * The §I/§J memo-invalidation pin: the artifacts policy's transition
 * report invalidates the skills staging memo — the flip-without-
 * invalidation bug §I exists to fix (a claim flip changes the bundled
 * tier's arming, and the memo only invalidated on skill writes, so
 * post-flip spawns kept pre-flip views) must not return silently.
 *
 * The wiring lives in createAppRuntime's report callback; this suite
 * pins the BEHAVIOR (the real policy + the runtime's callback shape
 * over a fake worktrees port, exactly §J's ask) without spinning the
 * whole runtime.
 */
import { describe, expect, it, vi } from "vitest";
import { createArtifactsPolicy } from "./artifacts/policy";

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

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("the report → invalidateSkills wiring contract", () => {
  it("the runtime's report callback invalidates the memo on every transition", async () => {
    const invalidateSkills = vi.fn();
    const settings = settingsPort(null);
    // The runtime's callback shape: invalidation fires on EVERY report.
    const policy = createArtifactsPolicy(
      settings,
      { enable: async () => 43119, disable: async () => {} },
      () => invalidateSkills(),
    );

    // Boot-null: no transition, no invalidation.
    await flush();
    expect(invalidateSkills).toHaveBeenCalledTimes(0);

    // The initial enable: one transition → one invalidation.
    settings.set(true);
    await flush();
    expect(invalidateSkills).toHaveBeenCalledTimes(1);

    // A later disable: another.
    settings.set(false);
    await flush();
    expect(invalidateSkills).toHaveBeenCalledTimes(2);

    policy.dispose();
  });

  it("an IDEMPOTENT re-enable fires NO transition and does NOT churn the memo", async () => {
    // The L-2 fold: desired === applied skips — no report, no
    // invalidation. Re-asserting the current state is not a flip.
    const invalidateSkills = vi.fn();
    const settings = settingsPort(true);
    const policy = createArtifactsPolicy(
      settings,
      { enable: async () => 43119, disable: async () => {} },
      () => invalidateSkills(),
    );

    await flush(); // the boot enable fired once
    expect(invalidateSkills).toHaveBeenCalledTimes(1);

    settings.set(true); // the SAME value
    await flush();
    expect(invalidateSkills).toHaveBeenCalledTimes(1); // unchanged

    policy.dispose();
  });

  it("a FAILED transition also invalidates (ok and failed alike)", async () => {
    const invalidateSkills = vi.fn();
    const settings = settingsPort(null);
    const policy = createArtifactsPolicy(
      settings,
      {
        enable: async () => {
          throw "artifact store is owned by another KeepDeck process";
        },
        disable: async () => {},
      },
      () => invalidateSkills(),
    );

    settings.set(true);
    await flush();
    expect(invalidateSkills).toHaveBeenCalledTimes(1);

    policy.dispose();
  });
});
