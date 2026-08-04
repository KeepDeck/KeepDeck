// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_NOW } from "../../domain/usage/history/event.testSupport";
import type { UsageStatsRow } from "../../domain/usage/history/query";
import { StatsTable } from "./StatsTable";

/** The Models/Sessions drill-down. It is handed rows and renders them, so
 * the cases here state rows directly — the query that produces them has its
 * own suite, and the dialog's tab routing has the shell's. */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

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
    host = document.getElementById("host")!;
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
    const table = host.querySelector('[role="table"]')!;
    expect(table.getAttribute("aria-label")).toBe("Models");
    expect(table.querySelectorAll('[role="row"]')).toHaveLength(1);
    // Identity, tokens, cost: a dropped column is the failure this counts.
    expect(table.querySelectorAll('[role="cell"]')).toHaveLength(3);
  });

  it("shows the total with its in/out breakdown, and the row's age", () => {
    render([row()]);
    const text = host.querySelector(".stats__row")!.textContent ?? "";
    expect(text).toContain("gpt-5.6-terra");
    expect(text).toContain("1.6k");
    // The breakdown behind the total — the reason the cell is not just a sum.
    expect(text).toContain("↑1k");
    expect(text).toContain("↓100");
    expect(text).toContain("1m ago");
  });

  it("does not render an unreported cost as a fake zero", () => {
    // A row nobody priced is not a free row.
    render([row({ providerCostUsd: 0, costEvents: 0 })]);
    expect(host.querySelector(".stats__row")!.textContent).toContain("—");
  });

  it("renders nothing at all rather than an empty frame", () => {
    // The tab switchboard owns the empty-ledger message; a bare heading over
    // a bare table would be a second, quieter answer to the same question.
    render([]);
    expect(host.querySelector(".stats__table")).toBeNull();
    expect(host.textContent).toBe("");
  });
});
