import { describe, expect, it } from "vitest";
import { periodless, statsTabStep } from "./statsTabs";

describe("statsTabStep", () => {
  it("selects the next or previous tab on an arrow, wrapping at the ends", () => {
    expect(statsTabStep("overview", "ArrowRight")).toBe("breakdown");
    expect(statsTabStep("limits", "ArrowLeft")).toBe("breakdown");
    expect(statsTabStep("weekly", "ArrowRight")).toBe("achievements");
    expect(statsTabStep("achievements", "ArrowRight")).toBe("overview");
    expect(statsTabStep("overview", "ArrowLeft")).toBe("achievements");
  });

  it("goes to the first and last tab on Home and End", () => {
    expect(statsTabStep("limits", "Home")).toBe("overview");
    expect(statsTabStep("breakdown", "End")).toBe("achievements");
  });

  it("leaves every other key alone", () => {
    expect(statsTabStep("overview", "ArrowDown")).toBeNull();
    expect(statsTabStep("overview", "Enter")).toBeNull();
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
