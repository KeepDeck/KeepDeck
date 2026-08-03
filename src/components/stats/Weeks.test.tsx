// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  TEST_NOW,
  usageEvent as event,
} from "../../domain/usage/history/event.testSupport";
import type { UsageEventV2 } from "../../domain/usage/history/event";
import { WEEK_MS } from "../../domain/usage/weeks";
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
    expect(host.textContent).toContain("Jul 20 – Jul 26");
    expect(host.textContent).toContain("↑ +100%"); // the FINISHED claude week
    expect(host.textContent).toContain("claude-sonnet-5· 100");
    expect(host.textContent).toContain("≈$1.50");
    expect(host.querySelector(".stats__week-row--current")).not.toBeNull();
    expect(host.querySelector(".stats__weeks-pager")).toBeNull(); // one page
  });

  it("gives an empty week in progress an honest line, not zero-and-dash", () => {
    const host = render([
      event({ occurredAt: NOW - WEEK_MS, tokens: { input: 100 } }),
    ]);
    expect(host.querySelectorAll('[role="row"]')).toHaveLength(2);
    const current = host.querySelector(".stats__week-row--current")!;
    expect(current.textContent).toContain("in progress");
    expect(current.textContent).toContain("no usage yet");
    // No husk cells: the empty state REPLACES the number columns.
    expect(current.querySelector(".stats__week-tokens")).toBeNull();
    expect(current.querySelector(".stats__week-cost")).toBeNull();
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
});
