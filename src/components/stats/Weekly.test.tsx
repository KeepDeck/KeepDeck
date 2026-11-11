// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usageEvent } from "../../domain/usage/history/event.testSupport";
import { ledgerOf } from "../../domain/usage/history/ledger.testSupport";
import { Weekly } from "./Weekly";
import { present } from "@keepdeck/plugin-api/testing";

/** The tab maps weeklyView (tested on its own); the cases here read what
 * the reader sees and what the tab emits. */
const NOW = Date.parse("2026-11-11T19:00:00Z");
const DAY = 86_400_000;

describe("Weekly", () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    host = present(document.getElementById("host"), "the #host element");
    root = createRoot(host);
  });
  afterEach(() => act(() => root.unmount()));

  const render = (onOpenGallery = vi.fn()) => {
    const rows = [usageEvent({ occurredAt: NOW - 60_000, costUsd: 3 }), usageEvent({ occurredAt: NOW - 9 * DAY, costUsd: 7 })];
    act(() =>
      root.render(
        createElement(Weekly, { ledger: ledgerOf(rows), now: NOW, journal: {}, reportsByKey: new Map(), onOpenGallery }),
      ),
    );
    return onOpenGallery;
  };
  const arrow = (label: string) => present(host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`), label);

  it("opens on this week and pages back to an earlier one and forward again", () => {
    render();
    expect(host.querySelector(".stats__weeknav b")?.textContent).toMatch(/^This week/);
    expect(host.querySelector(".stats__week-value")?.textContent).toBe("≈$3.00");
    expect(arrow("Later week").disabled).toBe(true);
    act(() => arrow("Earlier week").click());
    expect(host.querySelector(".stats__weeknav b")?.textContent).not.toMatch(/^This week/);
    expect(host.querySelector(".stats__week-value")?.textContent).toBe("≈$7.00");
    act(() => arrow("Later week").click());
    expect(host.querySelector(".stats__weeknav b")?.textContent).toMatch(/^This week/);
  });

  it("opens the badge gallery from this week's badge panel", () => {
    const open = render();
    act(() => present(host.querySelector<HTMLButtonElement>(".stats__link"), "the gallery door").click());
    expect(open).toHaveBeenCalledOnce();
  });
});
