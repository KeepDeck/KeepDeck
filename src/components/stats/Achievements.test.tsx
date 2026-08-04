// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageEventV2 } from "../../domain/usage/history/event";
import {
  TEST_NOW,
  usageEvent as baseEvent,
} from "../../domain/usage/history/event.testSupport";
import { Achievements } from "./Achievements";

/** The gallery takes one prop and computes everything else from the ledger,
 * so it is mounted directly: no history mock, no dialog shell, no tab click
 * between the assertion and the thing asserted. */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const NOW = TEST_NOW;
const usageEvent = (over: Record<string, unknown> = {}): UsageEventV2 =>
  baseEvent({
    capturedAt: NOW,
    tokens: { input: 1_000, output: 100, cacheRead: 500 },
    costUsd: 0.25,
    costSource: "provider",
    ...over,
  });

describe("Achievements", () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    // Fake timers throughout: the tips open on a hover-intent pause, and a
    // suite that switches clocks mid-test cannot mock the date first.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    document.body.innerHTML = "<div id='host'></div>";
    host = document.getElementById("host")!;
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  /** One million tokens and a quarter of a dollar: the first tokens tier is
   * won, its successor is under way, and everything above is locked. */
  const render = (events: UsageEventV2[] = [usageEvent({ tokens: { input: 2_000_000 } })]) =>
    act(() => root.render(createElement(Achievements, { events })));

  const cards = () => [...host.querySelectorAll(".stats__achievement")];
  const card = (text: string) =>
    cards().find((item) => item.textContent?.includes(text))!;

  it("splits the gallery into In progress, Earned and Locked", () => {
    render();

    const sections = [...host.querySelectorAll(".stats__section")];
    const byTitle = (title: string) =>
      sections.find(
        (section) => section.querySelector("h3")?.textContent === title,
      )!;
    const inProgress = byTitle("In progress");
    const earned = byTitle("Earned");
    const locked = byTitle("Locked");

    // The sections appear in that order — in-progress goals lead.
    expect(sections.indexOf(inProgress)).toBeLessThan(sections.indexOf(earned));
    expect(sections.indexOf(earned)).toBeLessThan(sections.indexOf(locked));

    expect(earned.textContent).toContain("First Million");
    expect(earned.textContent).toContain("earned Jul 22, 2026");
    expect(earned.textContent).toContain("Hello, Agent");

    // One goal per ladder, with progress…
    expect(inProgress.textContent).toContain("Picking Up Steam");
    expect(inProgress.textContent).toContain("2M / 25M");
    expect(inProgress.textContent).toContain("First Tenner");
    expect(inProgress.textContent).toContain("$0.25 / $10");
    // …while the tiers beyond it are visible but inert: present in Locked,
    // without a progress bar.
    expect(locked.textContent).toContain("Heavy Rotation");
    expect(locked.textContent).toContain("Token Tycoon");
    expect(locked.querySelector(".stats__achievement-progress")).toBeNull();
    expect(locked.querySelector(".stats__achievement--future")).not.toBeNull();
  });

  it("names each card's level in a class, and names it correctly", () => {
    render();

    // Every card declares a level — the dress is how the gallery reads, and
    // the class is the only part of it a DOM can see.
    for (const item of cards()) {
      expect(
        [...item.classList].some((name) =>
          /^stats__achievement--(common|uncommon|rare|epic|legendary)$/.test(name),
        ),
        item.textContent ?? "",
      ).toBe(true);
    }
    // Named tiers, not "one of the five": the level is computed from the
    // threshold, so an assertion that accepts any answer accepts a bug.
    expect(card("First Million").className).toContain(
      "stats__achievement--common",
    );
    expect(card("Heavy Rotation").className).toContain(
      "stats__achievement--rare",
    );
    expect(card("Token Tycoon").className).toContain(
      "stats__achievement--legendary",
    );
  });

  it("gives every decorative layer the class that keeps content rules off it", () => {
    render();
    const earned = card("First Million");
    expect(earned.querySelector(".stats__achievement-dress")).not.toBeNull();
    expect(earned.querySelector(".stats__achievement-rim")).not.toBeNull();
    // Without this class the layer joins the flow. The ember canvas is what
    // that cost: captured by the card's content rule it grew the card whose
    // height its own bitmap is measured from, and the pair ran away.
    for (const layer of earned.querySelectorAll(
      ".stats__achievement-dress, .stats__achievement-rim, .stats__achievement-embers",
    )) {
      expect(layer.classList.contains("stats__achievement-layer")).toBe(true);
    }
  });

  it("lights embers on an earned legendary alone, never on the promise of one", () => {
    // A locked tier keeps the colour of the level it will be and gives up
    // every effect. Only this half is visible to a DOM — the rest is the
    // stylesheet's, and vitest loads no stylesheet, so a test that looked
    // for a missing dress would pass against any card at all, earned or not.
    render([usageEvent({ tokens: { input: 1e9 } })]);

    const won = card("Supernova"); // a billion tokens in one day
    expect(won.className).toContain("stats__achievement--legendary");
    expect(won.className).not.toContain("stats__achievement--locked");
    expect(won.querySelector(".stats__achievement-embers")).not.toBeNull();

    const promised = card("Token Tycoon");
    expect(promised.className).toContain("stats__achievement--legendary");
    expect(promised.className).toContain("stats__achievement--locked");
    expect(promised.querySelector(".stats__achievement-embers")).toBeNull();
  });

  it("marks a re-earned top as an ordinal, never as a multiplier", () => {
    render();
    const named = (mark: string) =>
      cards().some((item) => item.textContent?.includes(`Token Tycoon ${mark}`));
    // Both re-earned tokens tops are named, and by an ordinal.
    expect(named("II")).toBe(true);
    expect(named("III")).toBe(true);
    // "×2" would claim twice the amount; the second top sits at ten times
    // the first, so the mark must not do arithmetic.
    for (const item of cards()) {
      expect(item.textContent).not.toContain("×");
    }
  });

  it("names the level in the tooltip, where colour alone would leave a reader out", () => {
    render();
    hover(card("First Million"));
    expect(tooltip()).toContain("Common");
    hover(card("First Million"), "mouseout");
    hover(card("Token Tycoon"));
    expect(tooltip()).toContain("Legendary");
  });

  it("carries the level as text a reader can reach without a mouse", () => {
    // A tip that opens on hover is a tip a keyboard never opens. Every level
    // is spelled out on the card itself, out of sight — the one place the
    // fact is available to someone who cannot use the colour.
    render([usageEvent({ tokens: { input: 1e9 } })]);
    const said = (item: Element) =>
      item.querySelector(".kd-sr")?.textContent ?? "";
    expect(said(card("First Million"))).toBe("Common");
    expect(said(card("Heavy Rotation"))).toBe("Rare");
    // "Marathon" would match "Marathon Session" too — a different tier at a
    // different level.
    expect(said(card("Leviathan"))).toBe("Epic");
    expect(said(card("Supernova"))).toBe("Legendary");
    // One line per card, not one per level: the four assertions above are
    // what pin the word itself. That it is INVISIBLE is the stylesheet's
    // doing, and no DOM in this suite loads a stylesheet.
    expect(card("Supernova").querySelectorAll(".kd-sr")).toHaveLength(1);
  });

  it("carries a hover tooltip with exact numbers on every card", () => {
    render();
    // Tips live behind the shared Tooltip: nothing renders until the
    // hover-intent pause passes, then the layer PORTALS to the body so the
    // scroller cannot clip it.
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    const steam = card("Picking Up Steam");
    hover(steam);
    expect(tooltip()).toContain("2,000,000 of 25,000,000 — 8%");
    hover(steam, "mouseout");

    const earned = card("First Million");
    hover(earned);
    expect(tooltip()).toContain("Earned Jul 22, 2026");
  });
});

/** The hover-intent pause is the component's, so the test waits it out
 * rather than restating the number. */
function hover(item: Element, type: "mouseover" | "mouseout" = "mouseover") {
  act(() => {
    item.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    vi.advanceTimersByTime(1_000);
  });
}

function tooltip(): string {
  return document.querySelector('[role="tooltip"]')!.textContent ?? "";
}
