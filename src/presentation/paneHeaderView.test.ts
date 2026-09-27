import { describe, expect, it } from "vitest";
import type { ActivityBadge } from "../domain/status";
import { paneHeaderView, type PaneHeaderInput } from "./paneHeaderView";

const NOW = 1_700_000_000_000;
const badge = (tone: ActivityBadge["tone"], label: string, detail?: string): ActivityBadge => ({
  tone, label, sentence: label.toLowerCase(), detail, at: NOW - 3 * 60_000,
});
const input = (over: Partial<PaneHeaderInput> = {}): PaneHeaderInput => ({
  activity: null, now: NOW, ctxPct: undefined, paneLive: true, team: null, showTeamName: false, ...over,
});

describe("paneHeaderView", () => {
  it("says the state in words only while the agent needs a person or has failed", () => {
    expect(paneHeaderView(input({ activity: badge("waiting", "Needs approval") })).stateWord).toBe("Needs approval");
    expect(paneHeaderView(input({ activity: badge("failed", "Rate limited") })).stateWord).toBe("Rate limited");
    expect(paneHeaderView(input({ activity: badge("working", "Working") })).stateWord).toBeNull();
    expect(paneHeaderView(input({ activity: badge("done", "Done") })).stateWord).toBeNull();
  });

  it("keeps the dot for every state, with the words and the age in its tooltip", () => {
    const view = paneHeaderView(input({ activity: badge("failed", "Rate limited", "resets 18:40") }));
    expect(view.status).toEqual({ tone: "failed", label: "Rate limited", tooltip: "Rate limited — resets 18:40 · 3m ago" });
    expect(paneHeaderView(input()).status).toBeNull();
  });

  it("names the teammate by role, adding the team only where the deck runs several", () => {
    const team = { name: "redesign", role: "impl-1" };
    expect(paneHeaderView(input({ team })).role?.text).toBe("impl-1");
    expect(paneHeaderView(input({ team, showTeamName: true })).role?.text).toBe("impl-1 · redesign");
    expect(paneHeaderView(input()).role).toBeNull();
  });

  it("shows context only while the process is live, rounded up, with its level", () => {
    expect(paneHeaderView(input({ ctxPct: 41.2 })).ctx).toEqual({ label: "42%", title: "Context 42% used", level: "ok" });
    expect(paneHeaderView(input({ ctxPct: 80 })).ctx?.level).toBe("warn");
    expect(paneHeaderView(input({ ctxPct: 80, paneLive: false })).ctx).toBeNull();
  });
});
