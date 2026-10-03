import type { SegmentedOption } from "@keepdeck/ui-kit/Segmented";

/** A setting's two answers, in the order every switch in the app shows
 * them. One list, so no row says "Enabled" where its neighbour says "On". */
export const ON_OFF: readonly SegmentedOption<boolean>[] = [
  { value: true, label: "On" },
  { value: false, label: "Off" },
];
