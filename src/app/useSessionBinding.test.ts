import { describe, expect, it } from "vitest";
import { postbackAccepted } from "./useSessionBinding";

// The bridge's anti-forgery rule: an inbox postback binds a pane only when
// it echoes the per-spawn secret. Writing a file is not enough.
describe("postbackAccepted", () => {
  it("accepts only the exact token the pane's spawn carried", () => {
    expect(postbackAccepted({ token: "tok" }, "tok")).toBe(true);
    expect(postbackAccepted({ token: "tok" }, "forged")).toBe(false);
  });

  it("a pane that armed no reporter accepts nothing", () => {
    // No cached spec at all (unknown pane, or postback outlived the pane).
    expect(postbackAccepted(undefined, "tok")).toBe(false);
    // A spec without a token (bridge was down at spawn) — nothing could
    // legitimately post back, so nothing may bind.
    expect(postbackAccepted({}, "tok")).toBe(false);
    expect(postbackAccepted({ token: "" }, "")).toBe(false);
  });
});
