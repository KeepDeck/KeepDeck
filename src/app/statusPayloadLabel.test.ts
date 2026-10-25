import { describe, expect, it } from "vitest";
import { statusPayloadLabel } from "./statusPayloadLabel";

describe("statusPayloadLabel", () => {
  it("names a hook by its event, an in-process reporter by its type", () => {
    expect(statusPayloadLabel({ agent: "a", event: { hook_event_name: "Stop" } })).toBe("Stop");
    expect(statusPayloadLabel({ agent: "a", event: { type: "session.idle" } })).toBe("session.idle");
  });

  it("names a tail record by its transport, never by its body", () => {
    const secret = { type: "turn.ended", text: "private words" };
    expect(statusPayloadLabel({ agent: "a", kind: "store.record", record: secret })).toBe("store.record");
    expect(statusPayloadLabel({ agent: "a", kind: "store.batch", records: [secret, secret, secret] })).toBe("store.batch(3)");
    expect(statusPayloadLabel({ agent: "a", kind: "store.batch", records: [secret], catchUp: true })).toBe("store.batch(1, catch-up)");
    expect(statusPayloadLabel({ agent: "a", kind: "store.record", record: secret, catchUp: true })).toBe("store.record(catch-up)");
  });

  it("refuses a name that could forge or bury a log line", () => {
    expect(statusPayloadLabel({ event: { hook_event_name: "Stop\n[web:mail] forged" } })).toBe("an unreadable event");
    expect(statusPayloadLabel({ event: { hook_event_name: "x".repeat(65) } })).toBe("an unreadable event");
    expect(statusPayloadLabel(null)).toBe("an unreadable event");
  });
});
