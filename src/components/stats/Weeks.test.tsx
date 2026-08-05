// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  TEST_NOW,
  usageEvent as event,
} from "../../domain/usage/history/event.testSupport";
import type { UsageEventV2 } from "../../domain/usage/history/event";
import { WEEK_MS } from "../../domain/usage/time";
import { Weeks } from "./Weeks";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const NOW = TEST_NOW; // Wednesday; the current week opened Mon Jul 20

let root: Root;
afterEach(() => act(() => root.unmount()));

function render(events: readonly UsageEventV2[]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(createElement(Weeks, { events, now: NOW })));
  return host;
}

const click = (button: Element) =>
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

describe("Weeks", () => {
  it("renders nothing over an empty ledger", () => {
    const host = render([]);
    expect(host.innerHTML).toBe("");
  });

  it("shows each week's numbers and marks the current one", () => {
    const host = render([
      event({ tokens: { input: 300 } }),
      event({
        occurredAt: NOW - WEEK_MS,
        agent: "claude",
        model: "claude-sonnet-5",
        tokens: { input: 100 },
        costSource: "provider",
        costUsd: 1.5,
      }),
      event({ occurredAt: NOW - 2 * WEEK_MS, tokens: { input: 50 } }),
    ]);
    expect(host.textContent).toContain("Jul 13 – Jul 19");
    expect(host.textContent).toContain("↑ +100%"); // the FINISHED claude week
    expect(host.textContent).toContain("claude-sonnet-5· 100");
    expect(host.textContent).toContain("≈$1.50");
    expect(host.querySelector(".stats__weeks-pager")).toBeNull(); // one page
  });

  it("marks the week in progress without dimming it", () => {
    const host = render([
      event({ tokens: { input: 300 } }),
      event({ occurredAt: NOW - WEEK_MS, tokens: { input: 100 } }),
    ]);
    const rows = [...host.querySelectorAll<HTMLElement>('[role="row"]')];
    const current = rows[0];
    // Named and counted, not faded: translucency reads as disabled, and
    // this is the freshest row on the block.
    expect(current.textContent).toContain("This week");
    expect(current.querySelector(".stats__week-progress")!.textContent).toBe(
      "3 of 7 days",
    );
    expect(current.querySelector(".stats__week-rest")).not.toBeNull();
    // The delta cell is the progress cell — an in-progress week has nothing
    // to compare against, so the column carries the other true thing.
    expect(current.querySelector(".stats__week-delta")).toBeNull();

    // A finished week keeps its dates, its delta, and no remainder track.
    expect(rows[1].textContent).toContain("Jul 13 – Jul 19");
    expect(rows[1].querySelector(".stats__week-rest")).toBeNull();
    expect(rows[1].querySelector(".stats__week-progress")).toBeNull();
  });

  it("answers a bar hover with the week's per-agent breakdown", () => {
    const host = render([
      event({ tokens: { input: 700 } }), // codex
      event({ agent: "claude", tokens: { input: 300 } }),
    ]);
    const anchor = host.querySelector(".kd-tip__anchor")!;
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    act(() => {
      anchor.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    const tip = document.querySelector('[role="tooltip"]')!;
    expect(tip.textContent).toContain("This week");
    expect(tip.textContent).toContain("codex · 700");
    expect(tip.textContent).toContain("claude · 300");
  });

  it("gives an empty week in progress an honest line, not zero-and-dash", () => {
    const host = render([
      event({ occurredAt: NOW - WEEK_MS, tokens: { input: 100 } }),
    ]);
    const rows = [...host.querySelectorAll('[role="row"]')];
    expect(rows).toHaveLength(2);
    const current = rows[0];
    expect(current.textContent).toContain("in progress");
    expect(current.textContent).toContain("no usage yet");
    // No husk cells: the empty state REPLACES the number columns.
    expect(current.querySelector(".stats__week-tokens")).toBeNull();
    expect(current.querySelector(".stats__week-cost")).toBeNull();
  });

  it("shows a cost-only week in progress — spend is usage too", () => {
    const host = render([
      event({ tokens: {}, costSource: "provider", costUsd: 4.25 }),
    ]);
    expect(host.textContent).not.toContain("no usage yet");
    expect(host.textContent).toContain("≈$4.25");
  });

  it("pages by 8 with a constant height — older weeks behind the pager", () => {
    const events = Array.from({ length: 12 }, (_, index) =>
      event({
        occurredAt: NOW - index * WEEK_MS,
        tokens: { input: 100 + index },
      }),
    );
    const host = render(events);
    expect(host.querySelectorAll('[role="row"]')).toHaveLength(8);
    expect(host.textContent).toContain("1–8 of 12");
    const newer = host.querySelector('[aria-label="Newer weeks"]')!;
    const older = host.querySelector('[aria-label="Older weeks"]')!;
    expect((newer as HTMLButtonElement).disabled).toBe(true);
    click(older);
    expect(host.querySelectorAll('[role="row"]')).toHaveLength(4);
    expect(host.textContent).toContain("9–12 of 12");
    expect(
      (host.querySelector('[aria-label="Older weeks"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (host.querySelector('[aria-label="Newer weeks"]') as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("snaps a stale page back when the week list shrinks", () => {
    const twelve = Array.from({ length: 12 }, (_, index) =>
      event({
        occurredAt: NOW - index * WEEK_MS,
        tokens: { input: 100 + index },
      }),
    );
    const host = render(twelve);
    click(host.querySelector('[aria-label="Older weeks"]')!);
    expect(host.textContent).toContain("9–12 of 12");
    // The list shrinks under the stored page: show the LAST page, never
    // an empty one.
    act(() =>
      root.render(
        createElement(Weeks, { events: twelve.slice(0, 4), now: NOW }),
      ),
    );
    expect(host.querySelectorAll('[role="row"]')).toHaveLength(4);
    expect(host.querySelector(".stats__weeks-pager")).toBeNull();
  });

  it("dashes the model of a finished zero week", () => {
    const host = render([
      event({ occurredAt: NOW - 2 * WEEK_MS, tokens: { input: 100 } }),
    ]);
    // Rows: empty current, zero finished week, the used week.
    const rows = host.querySelectorAll('[role="row"]');
    expect(rows).toHaveLength(3);
    expect(rows[1].querySelector(".stats__week-model")!.textContent).toBe("—");
  });
});
