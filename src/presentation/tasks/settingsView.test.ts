import { describe, expect, it } from "vitest";
import { offWaitingHint, showTasksSocketHint } from "./settingsView";

describe("settingsView", () => {
  it("says the socket is down only while the feature is on and the socket is not", () => {
    expect(showTasksSocketHint(true, false)).toBe(true);
    expect(showTasksSocketHint(true, true)).toBe(false);
    expect(showTasksSocketHint(false, false)).toBe(false);
  });

  it("says why Off is waiting, and that it completes on its own — nothing when it is not", () => {
    expect(offWaitingHint("keepdeck's board — disk full")).toBe(
      "Off is waiting: keepdeck's board — disk full. The board keeps the changes and retries on its own; Off completes once they are saved.",
    );
    expect(offWaitingHint(null)).toBeNull();
  });
});
