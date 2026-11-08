import type { UsageTimeline } from "../../domain/usage/daily";

/** The chart's title, which is also its accessible name, by the step of its
 * buckets. Exhaustive by construction: a new granularity fails to compile
 * until it names its title. */
const TITLES: Record<UsageTimeline["granularity"], string> = {
  hour: "Hourly tokens",
  day: "Daily tokens",
};

export function usageChartTitle(granularity: UsageTimeline["granularity"]): string {
  return TITLES[granularity];
}
