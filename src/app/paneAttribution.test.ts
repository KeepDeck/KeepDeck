import { describe, expect, it } from "vitest";
import type { Workspace } from "../domain/deck";
import type { SessionBound } from "../ipc/sessions";
import { bindingOrigin, createPaneAttribution } from "./paneAttribution";

/**
 * The owner, not the rule — the rule is covered on plain values in
 * src/domain/agents/sessionAttribution.test.ts. What can only be tested here
 * is the mutable half: which generation is pinned to which process, and that
 * the two lifecycle calls open the door again in the right circumstances.
 */
const workspaces = [
  {
    id: "ws-1",
    panes: [{ id: "pane-1", agentType: "claude" }, { id: "pane-2" }],
  },
] as unknown as Workspace[];

const attribution = () =>
  createPaneAttribution({
    workspaces: () => workspaces,
    secretOf: () => "tok",
  });

const report = (over: Partial<SessionBound> = {}): SessionBound => ({
  paneId: "pane-1",
  sessionId: "s-1",
  token: "tok",
  agent: "claude",
  source: "startup",
  reporter: "4021",
  ...over,
});

describe("bindingOrigin", () => {
  it("reads every word our agents use for a continued conversation", () => {
    for (const word of ["resume", "clear", "compact", "fork", "new"]) {
      expect(bindingOrigin(word), word).toBe("swap");
    }
  });

  it("treats a word it does not know as a fresh start, not a continuation", () => {
    // The strict side: an unknown word can then only be refused as a second
    // start. Read as a continuation it would overwrite the pane's identity.
    expect(bindingOrigin("teleported")).toBe("startup");
    expect(bindingOrigin(undefined)).toBe("startup");
  });
});

describe("createPaneAttribution", () => {
  it("pins the generation to the process that bound it", () => {
    const owner = attribution();
    expect(owner.judge(report())).toEqual({ accepted: true });
    owner.recordBinding("pane-1", "4021");

    // The same process may rebind as often as its conversation changes id.
    expect(owner.judge(report({ source: "clear", sessionId: "s-2" }))).toEqual({
      accepted: true,
    });
    // Another process may not, whatever it calls the event.
    expect(
      owner.judge(report({ source: "resume", reporter: "9137" })),
    ).toEqual({ accepted: false, refusal: "foreign-process" });
    // And the same process may not start a SECOND fresh session.
    expect(owner.judge(report({ sessionId: "s-3" }))).toEqual({
      accepted: false,
      refusal: "second-startup",
    });
  });

  it("keeps the pin a report that cannot name its process would erase", () => {
    // The four-step theft this guards: pin 4021 · the pane's own agent
    // rebinds after a `ps` failure (no reporter, so the process rule cannot
    // speak) · a nested run rebinds and becomes the new pin · the pane's own
    // agent is refused as foreign for the rest of the generation.
    const owner = attribution();
    owner.recordBinding("pane-1", "4021");
    owner.recordBinding("pane-1", undefined);

    expect(
      owner.judge(report({ source: "resume", reporter: "9137" })),
    ).toEqual({ accepted: false, refusal: "foreign-process" });
    expect(owner.judge(report({ source: "clear" }))).toEqual({
      accepted: true,
    });
  });

  it("does not adopt a process a later report names when the first could not", () => {
    // Nothing distinguishes "the agent could not name itself, then could"
    // from "the agent could not, and something else answered instead", so a
    // generation that started blind stays blind rather than pinning to a
    // process it cannot vouch for.
    const owner = attribution();
    owner.recordBinding("pane-1", undefined);
    owner.recordBinding("pane-1", "9137");

    expect(owner.judge(report({ source: "clear" }))).toEqual({
      accepted: true,
    });
  });

  it("re-opens the door when the pane's process retires", () => {
    // The one thing a paneLifecycle.retire spy cannot show: that retiring
    // actually lets the pane's NEXT process bind, rather than leaving it
    // refusing its own agent for the rest of the session.
    const owner = attribution();
    owner.recordBinding("pane-1", "4021");
    expect(owner.judge(report({ reporter: "9137" }))).toEqual({
      accepted: false,
      refusal: "foreign-process",
    });

    owner.retire("pane-1");
    expect(owner.judge(report({ reporter: "9137" }))).toEqual({
      accepted: true,
    });
  });

  it("forgets panes the deck no longer holds, and keeps the ones it does", () => {
    const owner = attribution();
    owner.recordBinding("pane-1", "4021");
    owner.forget(new Set(["pane-2"]));
    // Forgotten: a fresh session from a different process is its own again.
    expect(owner.judge(report({ reporter: "9137" }))).toEqual({
      accepted: true,
    });

    owner.recordBinding("pane-1", "4021");
    owner.forget(new Set(["pane-1", "pane-2"]));
    expect(owner.judge(report({ reporter: "9137" }))).toEqual({
      accepted: false,
      refusal: "foreign-process",
    });
  });

  it("reads a pane's agent through the catalog's default, not the raw field", () => {
    // `pane-2` has no recorded type, so it RUNS the default agent and arms
    // its reporter under that name. Reading the field raw would refuse every
    // report such a pane makes — binding, usage and status alike.
    const owner = attribution();
    expect(owner.judge(report({ paneId: "pane-2" }))).toEqual({
      accepted: true,
    });
    expect(owner.admitsReport("pane-2", "tok", "claude", "4021")).toBe(true);
  });

  it("admits a report only from the pane's own agent, with the pane's secret", () => {
    const owner = attribution();
    expect(owner.admitsReport("pane-1", "tok", "claude", "4021")).toBe(true);
    expect(owner.admitsReport("pane-1", "tok", "kimi", "4021")).toBe(false);
    expect(owner.admitsReport("pane-1", "forged", "claude", "4021")).toBe(false);
    expect(owner.admitsReport("pane-1", "tok", undefined, "4021")).toBe(false);
    // A pane the deck no longer holds has no agent to speak for.
    expect(owner.admitsReport("pane-gone", "tok", "claude", "4021")).toBe(false);
  });

  it("refuses a report from a process the pane's generation is not pinned to", () => {
    // The lane the identity rule does not cover: a nested run refused a
    // binding still holds a valid secret and names the pane's own agent, and
    // its statusline would otherwise write this pane's usage and context.
    const owner = attribution();
    owner.recordBinding("pane-1", "4021");
    expect(owner.admitsReport("pane-1", "tok", "claude", "9137")).toBe(false);
    expect(owner.admitsReport("pane-1", "tok", "claude", "4021")).toBe(true);
    // Before anything bound, and from a reporter that cannot name itself,
    // the pin has nothing to say and the other two rules decide alone.
    expect(owner.admitsReport("pane-2", "tok", "claude", "9137")).toBe(true);
    expect(owner.admitsReport("pane-1", "tok", "claude", undefined)).toBe(true);
  });
});
