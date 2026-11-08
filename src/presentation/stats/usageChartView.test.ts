import { describe, expect, it } from "vitest";
import { usageChartTitle } from "./usageChartView";

describe("usageChartTitle", () => {
  it("names the chart by the step of its buckets", () => {
    expect(usageChartTitle("hour")).toBe("Hourly tokens");
    expect(usageChartTitle("day")).toBe("Daily tokens");
  });
});
