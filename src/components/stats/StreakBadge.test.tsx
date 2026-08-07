// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The chip asks for ONE number and draws it. What counts as an active day,
 * and how the clock is floored, belong to `useStreakDays` and the witness
 * behind it and are tested there — mounting a whole runtime here would test
 * that composition a second time, badly. So the hook is the seam. */
const streak = vi.hoisted(() => ({ days: 0 }));
vi.mock("../../app/useStreakDays", () => ({
  useStreakDays: () => streak.days,
}));

import { StreakBadge } from "./StreakBadge";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("StreakBadge", () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    host = document.getElementById("host")!;
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const render = (days: number) => {
    streak.days = days;
    act(() => root.render(createElement(StreakBadge)));
    return host.querySelector(".stats__streak");
  };

  it("says the count in words as well as digits", () => {
    const chip = render(4)!;
    expect(chip.getAttribute("aria-label")).toBe("4-day streak");
    expect(chip.textContent).toContain("4");
    // Singular is its own case: "1 days" would be the kind of detail that
    // makes a chip look machine-written.
    expect(render(1)!.getAttribute("aria-label")).toBe("1-day streak");
    expect(render(1)!.textContent).toContain("day");
    expect(render(1)!.textContent).not.toContain("days");
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
    const none = render(2)!;
    expect(none.className).toContain("stats__streak--none");
    expect(marks(none)).toEqual({ coal: false, fire: false });

    const ember = render(4)!;
    expect(ember.className).toContain("stats__streak--ember");
    expect(marks(ember)).toEqual({ coal: true, fire: false });

    const flame = render(8)!;
    expect(flame.className).toContain("stats__streak--flame");
    expect(marks(flame)).toEqual({ coal: false, fire: true });

    expect(render(31)!.className).toContain("stats__streak--blaze");
    expect(render(101)!.className).toContain("stats__streak--inferno");
  });

  it("says nothing at all rather than announcing a zero", () => {
    // A chip reading "0" would be a chip announcing a failure, which is not
    // what a streak counter is for.
    expect(render(0)).toBeNull();
  });
});
