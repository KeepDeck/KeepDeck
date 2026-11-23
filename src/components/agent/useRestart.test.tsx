// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRestartMode } from "../../domain/agents";
import type { IntentOutcome } from "../../domain/lifecycle";
import { intentOutcomeText } from "../../presentation/lifecycleWords";
import { useRestart } from "./useRestart";
import { present } from "@keepdeck/plugin-api/testing";

const ACCEPTED: IntentOutcome = { kind: "accepted", op: 1, minted: { workspace: null, team: null, panes: [] } };
const REFUSED: IntentOutcome = { kind: "refused", refusal: { kind: "notFound" } };

/** Drive the hook from a throwaway component, exposing its state to the test.
 * The machine could not be reached at all while it lived inside the pane. */
function harness(
  onRestart?: (mode: AgentRestartMode) => Promise<IntentOutcome>,
  idle: unknown = null,
) {
  let state: ReturnType<typeof useRestart> | undefined;
  const Probe = ({ stopped }: { stopped: unknown }) => {
    state = useRestart(onRestart, stopped);
    return null;
  };
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(createElement(Probe, { stopped: idle })));
  return {
    root,
    Probe,
    read: () => present(state, "the state"),
    park(stopped: unknown) {
      act(() => root.render(createElement(Probe, { stopped })));
    },
  };
}

describe("useRestart", () => {
  let roots: Root[];
  beforeEach(() => {
    roots = [];
  });
  afterEach(() => {
    for (const root of roots) act(() => root.unmount());
  });

  it("keeps the spinner up for a restart that will remount the pane", async () => {
    // Only an accepted restart bumps the epoch, and that remount is what
    // clears this card. Clearing it on the promise instead would flash the
    // old card back for a frame over a pane that is already going away.
    const h = harness(async () => ACCEPTED);
    roots.push(h.root);
    await act(async () => h.read().restart("fresh"));
    expect(h.read().restarting).toBe(true);
    expect(h.read().restartFailed).toBe(false);
  });

  it("stands down when the restart did not happen", async () => {
    // The pane was stopped or closed under it: the promise resolves and no
    // remount is coming, so a spinner left up promises a restart that will
    // never arrive.
    const h = harness(async () => REFUSED);
    roots.push(h.root);
    await act(async () => h.read().restart("fresh"));
    expect(h.read().restarting).toBe(false);
    expect(h.read().restartFailed).toBe(false);
    // And says why, in the machine's words — never a card gone quiet.
    expect(h.read().refusal).toBe(intentOutcomeText(REFUSED));
    // The next attempt starts clean.
    await act(async () => h.read().restart("fresh"));
    expect(h.read().refusal).toBe(intentOutcomeText(REFUSED));
  });

  it("clears a refusal once the pane stops", async () => {
    const h = harness(async () => REFUSED);
    roots.push(h.root);
    await act(async () => h.read().restart("fresh"));
    expect(h.read().refusal).not.toBeNull();
    h.park({ reason: "suspended" });
    expect(h.read().refusal).toBeNull();
  });

  it("lets the user try again after a failure, or a restart the machine never answered", async () => {
    for (const fails of [
      async (): Promise<IntentOutcome> => {
        throw new Error("no");
      },
      async (): Promise<IntentOutcome> => ({ kind: "unanswered", reply: { kind: "unavailable" } }),
    ]) {
      const h = harness(fails);
      roots.push(h.root);
      await act(async () => h.read().restart("fresh"));
      expect(h.read().restarting).toBe(false);
      expect(h.read().restartFailed).toBe(true);
    }
  });

  it("ignores a second ask while one is in flight", async () => {
    // Both choices are inert until it settles: two restarts of one pane is
    // two spawns racing for the same slot.
    const onRestart = vi.fn(async () => ACCEPTED);
    const h = harness(onRestart);
    roots.push(h.root);
    await act(async () => {
      h.read().restart("fresh");
      h.read().restart("resume");
    });
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it("forgets a restart when the pane stops under it", async () => {
    // The pane keeps this component MOUNTED across a suspend, so without
    // this the card would outlive the process it describes — an exited pane
    // parked and resumed would paint "Agent exited" over a live terminal,
    // with a Restart button that kills the session just brought back.
    const h = harness(async () => ACCEPTED);
    roots.push(h.root);
    await act(async () => h.read().restart("fresh"));
    expect(h.read().restarting).toBe(true);

    h.park({ reason: "suspended" });
    expect(h.read().restarting).toBe(false);
    expect(h.read().restartFailed).toBe(false);
  });

  it("does nothing at all without a handler", () => {
    const h = harness(undefined);
    roots.push(h.root);
    act(() => h.read().restart("fresh"));
    expect(h.read().restarting).toBe(false);
  });
});
