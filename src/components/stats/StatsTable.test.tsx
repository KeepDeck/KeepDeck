// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_NOW } from "../../domain/usage/history/event.testSupport";
import type { UsageStatsRow } from "../../domain/usage/history/query";
import { StatsTable } from "./StatsTable";
import { present } from "@keepdeck/plugin-api/testing";

/** The Models/Sessions drill-down. It is handed rows and renders them, so
 * the cases here state rows directly — the query that produces them has its
 * own suite, and the dialog's tab routing has the shell's. */

const NOW = TEST_NOW;

const row = (over: Partial<UsageStatsRow> = {}): UsageStatsRow => ({
  key: "codex/gpt-5.6-terra",
  agent: "codex",
  model: "gpt-5.6-terra",
  tokens: { input: 1_000, output: 100, cacheRead: 500, cacheWrite: 0 },
  totalTokens: 1_600,
  providerCostUsd: 0.25,
  costEvents: 1,
  lastOccurredAt: NOW - 60_000,
  ...over,
});

describe("StatsTable", () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    vi.setSystemTime(NOW);
    document.body.innerHTML = "<div id='host'></div>";
    host = present(document.getElementById("host"), "the #host element");
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  const render = (rows: UsageStatsRow[], mode: "model" | "session" = "model") =>
    act(() =>
      root.render(createElement(StatsTable, { title: "Models", rows, now: NOW, mode })),
    );

  it("lays the rows out as a table a screen reader can navigate", () => {
    render([row()]);
    const table = present(host.querySelector('[role="table"]'), "the [role=\"table\"] element");
    expect(table.getAttribute("aria-label")).toBe("Models");
    expect(table.querySelectorAll('[role="row"]')).toHaveLength(1);
    // Identity, tokens, cost: a dropped column is the failure this counts.
    expect(table.querySelectorAll('[role="cell"]')).toHaveLength(3);
  });

  it("shows the total with its in/out breakdown, and the row's age", () => {
    render([row()]);
    const text = present(host.querySelector(".stats__row"), "the .stats__row element").textContent ?? "";
    expect(text).toContain("gpt-5.6-terra");
    expect(text).toContain("1.6k");
    // The breakdown behind the total — the reason the cell is not just a
    // sum. Cache leads because it is the biggest term, and the phrasing is
    // the domain's, shared with the Overview card.
    expect(text).toContain("cache 500 · ↑ 1k · ↓ 100");
    expect(text).toContain("1m ago");
  });

  it("does not render an unreported cost as a fake zero", () => {
    // A row nobody priced is not a free row.
    render([row({ providerCostUsd: 0, costEvents: 0 })]);
    expect(present(host.querySelector(".stats__row"), "the .stats__row element").textContent).toContain("—");
  });

  it("renders nothing at all rather than an empty frame", () => {
    // The tab switchboard owns the empty-ledger message; a bare heading over
    // a bare table would be a second, quieter answer to the same question.
    render([]);
    expect(host.querySelector(".stats__table")).toBeNull();
    expect(host.textContent).toBe("");
  });
});
