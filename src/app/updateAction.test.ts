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
    expect(updateActionView(stateAt("available"))?.action).toEqual({
      kind: "openUpdatesSettings",
    });
  });

  it("refuses a second press while a step is already running", () => {
    // The user has already asked; the three in-flight phases exist to say
    // which step is running, not to take another instruction.
    for (const phase of ["downloading", "discarding", "installing"] as const) {
      expect(updateActionView(stateAt(phase))?.disabled).toBe(true);
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
