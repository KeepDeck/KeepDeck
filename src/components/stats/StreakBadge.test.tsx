// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageEventV2 } from "../../domain/usage/history/event";

const history = vi.hoisted(() => ({
  snapshot: {
    ready: true,
    events: [] as UsageEventV2[],
    error: null as string | null,
    complete: true,
  },
}));
vi.mock("../../app/useUsageHistorySnapshot", () => ({
  useUsageHistorySnapshot: () => history.snapshot,
}));

/** The LIVE side: a pane that has reported today proves the reader is here
 * before that report has become recorded spend. */
const usage = vi.hoisted(() => ({
  snapshot: {
    accounts: new Map(),
    panes: new Map<string, { agent: string; reportedAt: number }>(),
  },
}));
vi.mock("../../app/useUsage", () => ({
  useUsage: () => usage.snapshot,
}));

import {
  TEST_NOW,
  usageEvent as baseEvent,
} from "../../domain/usage/history/event.testSupport";
import { StreakBadge } from "./StreakBadge";

/** The chip reads the ledger itself so it can sit in the dialog footer,
 * outside the tab body — so it is mounted alone here, with only the history
 * it reads. The dialog's job is to place it, and that stays in the shell's
 * own suite. */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const NOW = TEST_NOW;
const DAY = 24 * 60 * 60 * 1_000;

/** A ledger with `days` consecutive active days ending today. */
const streakOf = (days: number): UsageEventV2[] =>
  Array.from({ length: days }, (_, index) =>
    baseEvent({ eventId: `d-${index}`, occurredAt: NOW - index * DAY }),
  );

describe("StreakBadge", () => {
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

  const render = (events: UsageEventV2[], reportedAt?: number) => {
    history.snapshot = { ready: true, events, error: null, complete: true };
    usage.snapshot = {
      accounts: new Map(),
      panes:
        reportedAt === undefined
          ? new Map()
          : new Map([["pane-1", { agent: "claude", reportedAt }]]),
    };
    act(() => root.render(createElement(StreakBadge)));
    return host.querySelector(".stats__streak");
  };

  it("counts the run of consecutive days and says so in words", () => {
    const chip = render(streakOf(4))!;
    expect(chip.getAttribute("aria-label")).toBe("4-day streak");
    expect(chip.textContent).toContain("4");
  });

  it("climbs a heat tier at each threshold, and wears that tier's mark", () => {
    // The mark is the tier — a bigger number in the same chip would not read
    // as a longer streak, which is the whole reason the tiers exist.
    const marks = (chip: Element) => ({
      coal: chip.querySelector(".stats__streak-coal") !== null,
      fire: chip.querySelector(".stats__streak-fire") !== null,
    });

    // Below three days there is no tier and no mark — a two-day run is not
    // yet a streak worth a flame.
    const none = render(streakOf(2))!;
    expect(none.className).toContain("stats__streak--none");
    expect(marks(none)).toEqual({ coal: false, fire: false });

    const ember = render(streakOf(4))!;
    expect(ember.className).toContain("stats__streak--ember");
    expect(marks(ember)).toEqual({ coal: true, fire: false });

    const flame = render(streakOf(8))!;
    expect(flame.className).toContain("stats__streak--flame");
    expect(marks(flame)).toEqual({ coal: false, fire: true });

    expect(render(streakOf(31))!.className).toContain("stats__streak--blaze");
    expect(render(streakOf(101))!.className).toContain("stats__streak--inferno");
  });

  it("counts today from a live report, before it has become recorded spend", () => {
    // THE lag. The first report of a session seeds a baseline and writes
    // nothing to the ledger, so nothing landed there until the first turn
    // actually spent something — the count sat on yesterday's number while
    // the user was plainly working. A report is emitted from an agent's own
    // answer, so it means the same thing the ledger means, only sooner.
    const yesterdayOnly = [
      baseEvent({ eventId: "y", occurredAt: NOW - DAY }),
      baseEvent({ eventId: "y2", occurredAt: NOW - 2 * DAY }),
    ];
    expect(render(yesterdayOnly)!.getAttribute("aria-label")).toBe(
      "2-day streak",
    );
    expect(render(yesterdayOnly, NOW - 60_000)!.getAttribute("aria-label")).toBe(
      "3-day streak",
    );
  });

  it("does not let a stale report claim today", () => {
    // A pane whose last word was yesterday proves yesterday, not now.
    const yesterdayOnly = [baseEvent({ eventId: "y", occurredAt: NOW - DAY })];
    expect(render(yesterdayOnly, NOW - DAY)!.getAttribute("aria-label")).toBe(
      "1-day streak",
    );
  });

  it("says nothing at all once the streak is broken", () => {
    // Five days ago and nothing since: a chip reading "0" would be a chip
    // announcing a failure, which is not what a streak counter is for.
    expect(render([baseEvent({ occurredAt: NOW - 5 * DAY })])).toBeNull();
  });

  it("says nothing on an empty ledger", () => {
    expect(render([])).toBeNull();
  });
});
