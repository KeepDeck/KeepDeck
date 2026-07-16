import { describe, expect, it } from "vitest";
import { setupPresentation } from "./SetupSection";

describe("Kimi setup presentation", () => {
  it("keeps all onboarding copy inside the not-configured warning", () => {
    const view = setupPresentation({
      kind: "not-configured",
      operation: null,
    });

    expect(view).toMatchObject({
      tone: "pending",
      title: "Not configured",
      action: "configure",
      actionLabel: "Configure",
    });
    expect(view.detail).toContain("needs a one-time setup");
    expect(view.detail).toContain("starts a fresh session after restart");
  });

  it("shows exactly Remove after a healthy current setup", () => {
    expect(
      setupPresentation({
        kind: "configured",
        operation: null,
        version: "1.0.0",
      }),
    ).toMatchObject({
      tone: "ready",
      title: "Configured",
      action: "remove",
      actionLabel: "Remove",
    });
  });

  it("instructs already-running Kimi panes to reload after configuration", () => {
    const view = setupPresentation({
      kind: "configured",
      operation: null,
      version: "1.0.0",
      runningSessionsNeedReload: true,
    });
    expect(view).toMatchObject({
      tone: "update",
      title: "Configured — reload running sessions",
      action: "remove",
      actionLabel: "Remove",
    });
    expect(view.detail).toContain("Run /reload once");
    expect(view.detail).toContain("already-running Kimi pane");
    expect(view.detail).toContain("no process restart is needed");
  });

  it("keeps one Configure action while explaining removal to running panes", () => {
    const view = setupPresentation({
      kind: "not-configured",
      operation: null,
      runningSessionsNeedReload: true,
    });
    expect(view).toMatchObject({
      tone: "update",
      title: "Removed — reload running sessions",
      action: "configure",
      actionLabel: "Configure",
    });
    expect(view.detail).toContain("Run /reload once");
  });

  it("shows exactly Update for an outdated setup", () => {
    expect(
      setupPresentation({
        kind: "needs-attention",
        operation: null,
        version: "0.9.0",
        reason: "outdated",
      }),
    ).toMatchObject({
      tone: "update",
      title: "Update required",
      action: "configure",
      actionLabel: "Update",
    });
  });

  it("has no action while checking and one disabled action while working", () => {
    expect(
      setupPresentation({ kind: "checking", operation: null }),
    ).toMatchObject({ action: null, actionLabel: null, busy: true });

    expect(
      setupPresentation({
        kind: "working",
        operation: "configure",
        previous: { kind: "not-configured", operation: null },
      }),
    ).toMatchObject({
      action: "configure",
      actionLabel: "Configuring…",
      busy: true,
    });
  });
});
