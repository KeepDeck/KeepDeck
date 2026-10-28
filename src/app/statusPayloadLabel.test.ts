import { describe, expect, it } from "vitest";
import { attributedEvent, statusPayloadLabel } from "./statusPayloadLabel";

describe("statusPayloadLabel", () => {
  it("names a hook by the event its agent's plugin read, whatever field it came from", () => {
    expect(statusPayloadLabel({ agent: "a", event: { hook_event_name: "Stop" } }, "Stop")).toBe("Stop");
    expect(statusPayloadLabel({ agent: "a", event: { type: "session.idle" } }, "session.idle")).toBe("session.idle");
    // A fifth dialect the host has never heard of names itself the same way.
    expect(statusPayloadLabel({ agent: "a", event: { kind: "Finished" } }, "Finished")).toBe("Finished");
  });

  it("reads no field of a hook itself", () => {
    expect(statusPayloadLabel({ agent: "a", event: { hook_event_name: "Stop" } }, null)).toBe("an unreadable event");
  });

  it("refuses a name that could forge or bury a log line", () => {
    expect(statusPayloadLabel({ agent: "a", event: {} }, "Stop\nforged")).toBe("an unreadable event");
    expect(statusPayloadLabel({ agent: "a", event: {} }, "x".repeat(65))).toBe("an unreadable event");
  });

  it("names a tail record by its transport and never by what it carried", () => {
    const secret = { text: "do not log me" };
    expect(statusPayloadLabel({ agent: "a", kind: "store.record", record: secret }, null)).toBe("store.record");
    expect(statusPayloadLabel({ agent: "a", kind: "store.batch", records: [secret, secret, secret] }, null)).toBe("store.batch(3)");
    expect(statusPayloadLabel({ agent: "a", kind: "store.batch", records: [secret], catchUp: true }, null)).toBe("store.batch(1, catch-up)");
    expect(statusPayloadLabel({ agent: "a", kind: "store.record", record: secret, catchUp: true }, null)).toBe("store.record(catch-up)");
    expect(statusPayloadLabel({ agent: "a", kind: "store.batch", records: [secret, secret], reconcile: true }, null)).toBe("store.batch(2, reconcile)");
    expect(statusPayloadLabel({ agent: "a", kind: "store.record", record: secret, contextOnly: true }, null)).toBe("store.record(context)");
  });

  it("calls an unreadable payload unreadable", () => {
    expect(statusPayloadLabel(null, "Stop")).toBe("an unreadable event");
    expect(statusPayloadLabel({ agent: "a" }, null)).toBe("an unreadable event");
  });
});

describe("attributedEvent", () => {
  it("asks the agent's own reading, and takes a throw or none as no name", () => {
    expect(attributedEvent({ attribute: () => ({ event: "Stop", actor: "main", status: true }) }, {})).toBe("Stop");
    expect(attributedEvent({ attribute: () => null }, {})).toBeNull();
    expect(attributedEvent({ attribute: () => { throw new Error("plugin bug"); } }, {})).toBeNull();
    expect(attributedEvent(undefined, {})).toBeNull();
  });
});
