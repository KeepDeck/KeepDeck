import { describe, expect, it } from "vitest";
import { normalizeKimiStatus } from "./status";

const wrap = (event: Record<string, unknown>) => ({ agent: "kimi", event });

describe("normalizeKimiStatus", () => {
  it("maps the turn boundaries and both permission edges", () => {
    expect(
      normalizeKimiStatus(wrap({ hook_event_name: "UserPromptSubmit" }), 100),
    ).toEqual({ kind: "turn-start", at: 100 });
    expect(normalizeKimiStatus(wrap({ hook_event_name: "Stop" }), 200)).toEqual(
      { kind: "turn-end", at: 200 },
    );
    expect(
      normalizeKimiStatus(wrap({ hook_event_name: "PermissionRequest" }), 300),
    ).toEqual({ kind: "waiting", at: 300, reason: "permission" });
    expect(
      normalizeKimiStatus(wrap({ hook_event_name: "PermissionResult" }), 400),
    ).toEqual({ kind: "resumed", at: 400 });
  });

  it("maps kimi's native Interrupt — the event Stop deliberately skips", () => {
    expect(
      normalizeKimiStatus(
        wrap({ hook_event_name: "Interrupt", reason: "user" }),
        500,
      ),
    ).toEqual({ kind: "interrupted", at: 500 });
  });

  it("reads StopFailure's error class in either engine spelling", () => {
    // agent-core v1: snake_case.
    expect(
      normalizeKimiStatus(
        wrap({
          hook_event_name: "StopFailure",
          error_type: "ChatProviderError",
          error_message: "rate limited",
        }),
        600,
      ),
    ).toEqual({
      kind: "turn-failed",
      at: 600,
      error: "ChatProviderError",
      detail: "rate limited",
    });
    // agent-core v2: camelCase.
    expect(
      normalizeKimiStatus(
        wrap({ hook_event_name: "StopFailure", errorType: "ChatProviderError" }),
        600,
      ),
    ).toEqual({ kind: "turn-failed", at: 600, error: "ChatProviderError" });
    // Neither spelling present degrades to "unknown", never to a crash.
    expect(
      normalizeKimiStatus(wrap({ hook_event_name: "StopFailure" }), 600),
    ).toEqual({ kind: "turn-failed", at: 600, error: "unknown" });
  });

  it("drops untracked events and garbage", () => {
    expect(
      normalizeKimiStatus(wrap({ hook_event_name: "SessionStart" }), 100),
    ).toBeNull();
    expect(
      normalizeKimiStatus(wrap({ hook_event_name: "Notification" }), 100),
    ).toBeNull();
    expect(normalizeKimiStatus({ agent: "kimi" }, 100)).toBeNull();
    expect(normalizeKimiStatus(undefined, 100)).toBeNull();
  });
});
