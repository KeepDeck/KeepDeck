import { describe, expect, it } from "vitest";

import { updateActionView } from "./updateAction";
import type { UpdatePhase, UpdateState } from "./updateManager";

function stateAt(phase: UpdatePhase, version: string | null = "0.22.0"): UpdateState {
  return {
    phase,
    version,
    received: 0,
    total: null,
    error: null,
    checkedAt: null,
    changelog: [],
  };
}

describe("updateActionView", () => {
  it("says nothing while no update is in play", () => {
    // An idle updater has nothing to report, and a permanently greyed control
    // is a worse answer than an absent one.
    expect(updateActionView(stateAt("disabled"))).toBeNull();
    expect(updateActionView(stateAt("idle"))).toBeNull();
    expect(updateActionView(stateAt("checking"))).toBeNull();
  });

  it("offers the restart once the bundle is ready", () => {
    expect(updateActionView(stateAt("ready"))).toEqual({
      label: "Update ready · Restart",
      title: "Update to 0.22.0 and restart",
      disabled: false,
      action: { kind: "restart" },
    });
  });

  it("sends an available update to its settings section rather than acting", () => {
    // Nothing is downloaded yet, so the press cannot install anything — the
    // section owns the rest of the flow.
    expect(updateActionView(stateAt("available"))).toEqual({
      label: "Update available",
      title: "Version 0.22.0 is available",
      disabled: false,
      action: { kind: "openUpdatesSettings" },
    });
  });

  it("names the step that is running, and refuses a second press", () => {
    // The user has already asked; the three in-flight phases exist to say
    // WHICH step is running — which is the whole reason they are three phases
    // and not one. Asserting only `disabled` would let all three collapse into
    // the same label without a test noticing.
    const running = {
      downloading: "Downloading update…",
      discarding: "Discarding update…",
      installing: "Restarting…",
    } as const;
    for (const [phase, label] of Object.entries(running)) {
      expect(updateActionView(stateAt(phase as UpdatePhase))).toEqual({
        label,
        title: "Version 0.22.0 is available",
        disabled: true,
        // Unreachable while disabled, and deliberately not a fourth kind that
        // every caller would have to handle to describe a press that cannot
        // happen.
        action: { kind: "openUpdatesSettings" },
      });
    }
  });

  it("never renders a missing version as the word undefined", () => {
    // `version` is null until discovery lands, and both wordings are read by
    // a person: the ready one promises an upgrade, the rest state a fact.
    expect(updateActionView(stateAt("ready", null))?.title).toBe(
      "Update to new version and restart",
    );
    expect(updateActionView(stateAt("available", null))?.title).toBe(
      "Version ? is available",
    );
  });
});
