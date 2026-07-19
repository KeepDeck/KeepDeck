import { describe, expect, it } from "vitest";
import { usageSourceTimestamp } from "./usageProvenance";

describe("usageSourceTimestamp", () => {
  const receivedAt = Date.parse("2026-07-19T12:00:00.000Z");

  it("accepts finite past ISO and unix-millisecond provenance", () => {
    expect(usageSourceTimestamp("2026-07-19T11:59:00.000Z", receivedAt)).toBe(
      Date.parse("2026-07-19T11:59:00.000Z"),
    );
    expect(usageSourceTimestamp(2_000, receivedAt)).toBe(2_000);
  });

  it("rejects malformed, negative, non-finite and future provenance", () => {
    expect(usageSourceTimestamp("not-an-iso-time", receivedAt)).toBeNull();
    expect(usageSourceTimestamp("1969-12-31T23:59:59.000Z", receivedAt)).toBeNull();
    expect(usageSourceTimestamp(-1, receivedAt)).toBeNull();
    expect(usageSourceTimestamp(Number.POSITIVE_INFINITY, receivedAt)).toBeNull();
    expect(usageSourceTimestamp("2099-01-01T00:00:00.000Z", receivedAt)).toBeNull();
    expect(usageSourceTimestamp(receivedAt + 1, receivedAt)).toBeNull();
  });
});
