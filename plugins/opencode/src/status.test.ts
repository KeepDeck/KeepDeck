import { describe, expect, it } from "vitest";
import { normalizeOpencodeStatus } from "./status";

const wrap = (event: Record<string, unknown>) => ({ agent: "opencode", event });

describe("normalizeOpencodeStatus", () => {
  it("maps the reporter's pre-filtered bus events one-to-one", () => {
    expect(
      normalizeOpencodeStatus(wrap({ type: "session.status" }), 100),
    ).toEqual({ kind: "turn-start", at: 100 });
    expect(normalizeOpencodeStatus(wrap({ type: "session.idle" }), 200)).toEqual(
      { kind: "turn-end", at: 200 },
    );
    expect(
      normalizeOpencodeStatus(wrap({ type: "permission.asked" }), 300),
    ).toEqual({ kind: "waiting", at: 300, reason: "permission" });
    expect(
      normalizeOpencodeStatus(wrap({ type: "permission.replied" }), 400),
    ).toEqual({ kind: "resumed", at: 400 });
  });

  it("maps session.error with its name, degrading to a generic reason", () => {
    expect(
      normalizeOpencodeStatus(
        wrap({ type: "session.error", error: "ProviderAuthError" }),
        500,
      ),
    ).toEqual({ kind: "turn-failed", at: 500, error: "ProviderAuthError" });
    expect(
      normalizeOpencodeStatus(wrap({ type: "session.error" }), 500),
    ).toEqual({ kind: "turn-failed", at: 500, error: "session.error" });
  });

  it("drops untracked events and garbage", () => {
    expect(
      normalizeOpencodeStatus(wrap({ type: "message.updated" }), 100),
    ).toBeNull();
    expect(normalizeOpencodeStatus({ agent: "opencode" }, 100)).toBeNull();
    expect(normalizeOpencodeStatus(null, 100)).toBeNull();
  });
});
