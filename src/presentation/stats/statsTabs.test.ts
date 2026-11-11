import { describe, expect, it } from "vitest";
import { periodless, returnTab, statsTabStep, STRIP_TABS } from "./statsTabs";

describe("statsTabStep", () => {
  it("selects the next or previous tab on an arrow, wrapping at the ends", () => {
    expect(statsTabStep("overview", "ArrowRight")).toBe("breakdown");
    expect(statsTabStep("limits", "ArrowLeft")).toBe("breakdown");
    expect(statsTabStep("weekly", "ArrowRight")).toBe("overview");
    expect(statsTabStep("overview", "ArrowLeft")).toBe("weekly");
  });

  it("goes to the first and last tab on Home and End", () => {
    expect(statsTabStep("limits", "Home")).toBe("overview");
    expect(statsTabStep("breakdown", "End")).toBe("weekly");
  });

  it("walks the strip only — the gallery is reached by its doors, and arrows do nothing there", () => {
    expect(STRIP_TABS).toEqual(["overview", "breakdown", "limits", "weekly"]);
    expect(statsTabStep("achievements", "ArrowRight")).toBeNull();
  });

  it("leaves every other key alone", () => {
    expect(statsTabStep("overview", "ArrowDown")).toBeNull();
    expect(statsTabStep("overview", "Enter")).toBeNull();
  });
});

describe("returnTab", () => {
  it("leaves an off-strip destination for the tab it came from, and stays on a strip tab", () => {
    expect(returnTab("achievements", "weekly")).toBe("weekly");
    expect(returnTab("limits", "weekly")).toBe("limits");
  });
});

describe("periodless", () => {
  it("frees a tab that never reads the period switcher from it", () => {
    expect(periodless("limits")).toBe(true);
    expect(periodless("achievements")).toBe(true);
    expect(periodless("overview")).toBe(false);
    expect(periodless("breakdown")).toBe(false);
  });
});
