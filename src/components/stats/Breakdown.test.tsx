// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageRow } from "../../domain/usage/history/event";
import { TEST_NOW, usageEvent } from "../../domain/usage/history/event.testSupport";
import { ledgerOf } from "../../domain/usage/history/ledger.testSupport";
import type { StatsDimension } from "../../domain/usage/stats/dimensions";
import { Breakdown } from "./Breakdown";
import { present } from "@keepdeck/plugin-api/testing";

/** The table maps breakdownView (tested on its own); the cases here read
 * what the reader sees and what the table emits. */
const NOW = TEST_NOW;
const rows: UsageRow[] = ["s1", "s2"].map((sessionId, i) =>
  usageEvent({ occurredAt: NOW - 60_000, sessionId, paneName: `pane ${sessionId}`, costUsd: 2 - i }),
);

describe("Breakdown", () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    host = present(document.getElementById("host"), "the #host element");
    root = createRoot(host);
  });
  afterEach(() => act(() => root.unmount()));

  const render = (dimension: StatsDimension, onSelectDimension = vi.fn()) => {
    act(() =>
      root.render(
        createElement(Breakdown, {
          ledger: ledgerOf(rows),
          period: 7,
          now: NOW,
          colors: new Map(),
          perModelSince: null,
          dimension,
          order: "cost",
          onSelectDimension,
          onSelectOrder: () => {},
        }),
      ),
    );
    return onSelectDimension;
  };
  const bodyRows = () => [...host.querySelectorAll(".stats__bd-row:not(.stats__bd-row--head)")];

  it("lists the groups with their money and emits a new grouping", () => {
    const pick = render("workspace");
    expect(bodyRows().map((row) => row.querySelector(".stats__bd-name")?.textContent)).toEqual(["KeepDeck"]);
    expect(bodyRows()[0]?.textContent).toContain("≈$3.00");
    const agent = present(
      [...host.querySelectorAll<HTMLButtonElement>(".stats__choices button")].find((b) => b.textContent === "Agent"),
      "the Agent choice",
    );
    act(() => agent.click());
    expect(pick).toHaveBeenCalledWith("agent");
  });

  it("opens a group into its sessions and closes it again", () => {
    render("workspace");
    const toggle = () => present(host.querySelector<HTMLButtonElement>(".stats__bd-toggle"), "the group toggle");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    act(() => toggle().click());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelectorAll(".stats__bd-row--child")).toHaveLength(2);
    act(() => toggle().click());
    expect(host.querySelectorAll(".stats__bd-row--child")).toHaveLength(0);
  });

  it("names sessions by their pane and offers nothing to open under them", () => {
    render("session");
    expect(bodyRows().map((row) => row.querySelector(".stats__bd-name b")?.textContent)).toEqual(["pane s1", "pane s2"]);
    expect(host.querySelector(".stats__bd-toggle")).toBeNull();
  });
});
