import { describe, expect, it } from "vitest";
import { paneBody, type PaneBodyEnv } from "./paneBody";
import type { Pane } from "./panes";

const pane = (over: Partial<Pane> = {}): Pane => ({
  id: "pane-1",
  agentType: "claude",
  ...over,
});

const env = (over: Partial<PaneBodyEnv> = {}): PaneBodyEnv => ({
  agentAvailable: true,
  hasPlan: true,
  planFailed: false,
  ...over,
});

describe("paneBody", () => {
  it("mounts a terminal once a plan exists", () => {
    expect(paneBody(pane(), env())).toBe("terminal");
  });

  it("waits when there is no plan yet — the honest reading of not knowing", () => {
    expect(paneBody(pane(), env({ hasPlan: false }))).toBe("waiting");
  });

  it("shows the error tile when the build FAILED, not the waiting card", () => {
    // A permanent "Waking up…" hides a retry the user needs.
    expect(paneBody(pane(), env({ hasPlan: false, planFailed: true }))).toBe(
      "plan-failed",
    );
  });

  it("lets a rebuilt plan outrank the failure it replaced", () => {
    // Otherwise a successful retry keeps offering to retry.
    expect(paneBody(pane(), env({ planFailed: true }))).toBe("terminal");
  });

  it("reads a stopped pane by its marker, whatever its plan says", () => {
    expect(paneBody(pane({ idle: { reason: "parked" } }), env())).toBe(
      "stopped",
    );
  });

  it("names an absent agent over a stopped marker — the same order the run decision uses", () => {
    expect(
      paneBody(
        pane({ idle: { reason: "suspended", at: "2026-07-26" } }),
        env({ agentAvailable: false }),
      ),
    ).toBe("agent-unavailable");
  });

  it("shows the error tile over a stopped marker only when the pane is NOT stopped", () => {
    // The pair the closed set exists to order: a stopped pane reads by its
    // marker, whatever its plan did.
    expect(
      paneBody(
        pane({ idle: { reason: "parked" } }),
        env({ hasPlan: false, planFailed: true }),
      ),
    ).toBe("stopped");
  });

  it("reads a WAKING pane as stopped — the commonest marker there is", () => {
    expect(
      paneBody(pane({ idle: { reason: "waking", origin: "restore" } }), env()),
    ).toBe("stopped");
  });

  it("puts provisioning first: nothing else can be acted on without a directory", () => {
    expect(
      paneBody(
        pane({
          idle: { reason: "suspended", at: "2026-07-26" },
          provisioning: { repo: "/repo", workspace: "ws", index: 1 },
        }),
        env({ agentAvailable: false, hasPlan: false, planFailed: true }),
      ),
    ).toBe("provisioning");
  });
});
