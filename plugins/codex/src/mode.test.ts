import { describe, expect, it } from "vitest";
import { watchProject } from "@keepdeck/plugin-api";
import { codexModeEdge, codexPermissionMode } from "./mode";
import { normalizeCodexStatus } from "./status";
import { turnContextWatch } from "./turnContext";

const ISO = "2026-08-01T10:00:00Z";

describe("codexPermissionMode", () => {
  it("is YOLO only when codex neither asks nor sandboxes", () => {
    expect(codexPermissionMode("never", "danger-full-access", undefined)).toBe("yolo");
    // The newer profile model says "no sandbox" its own way.
    expect(codexPermissionMode("never", undefined, "disabled")).toBe("yolo");
  });

  it("reads a policy's fallback for what it is: asking without a sandbox is not YOLO", () => {
    // A managed requirement that forbids `never` falls back to the first
    // allowed approval, and the turn records the fallback, not the flag.
    expect(codexPermissionMode("on-request", "danger-full-access", undefined)).toBe("ask");
    for (const approval of ["untrusted", "on-failure", "on-request"]) {
      expect(codexPermissionMode(approval, "read-only", undefined), approval).toBe("ask");
    }
  });

  it("reads never asking inside a sandbox as codex deciding on its own", () => {
    expect(codexPermissionMode("never", "workspace-write", undefined)).toBe("auto");
    expect(codexPermissionMode("never", "read-only", undefined)).toBe("auto");
  });

  it("says nothing it cannot tell", () => {
    expect(codexPermissionMode("never", undefined, undefined)).toBeNull();
    expect(codexPermissionMode({ reject: {} }, "read-only", undefined)).toBeNull();
    expect(codexPermissionMode(undefined, "danger-full-access", undefined)).toBeNull();
  });
});

describe("a turn's settings, carried and read", () => {
  /** A `turn_context` as codex writes it — the bulk the watch leaves behind
   * included. */
  const turnContext = (payload: Record<string, unknown>) => ({
    timestamp: ISO,
    type: "turn_context",
    payload: { cwd: "/repo", model: "gpt-5", summary: "auto", ...payload },
  });

  it("carries the approval and the sandbox by their dotted names, and nothing else of the turn", () => {
    expect(
      watchProject(
        turnContextWatch,
        turnContext({
          approval_policy: "never",
          sandbox_policy: { type: "danger-full-access", network_access: true },
          collaboration_mode: { mode: "default" },
        }),
      ),
    ).toEqual({
      type: "turn_context",
      timestamp: ISO,
      "payload.collaboration_mode.mode": "default",
      "payload.approval_policy": "never",
      "payload.sandbox_policy.type": "danger-full-access",
    });
  });

  it("reports the mode a carried turn runs in, at the turn's own time", () => {
    const record = watchProject(turnContextWatch, turnContext({
      approval_policy: "on-request",
      sandbox_policy: { type: "danger-full-access" },
    }));
    expect(codexModeEdge(record)).toEqual({ kind: "permission-mode", at: Date.parse(ISO), mode: "ask" });
    const normalized = normalizeCodexStatus({ agent: "codex", kind: "store.record", record }, 999);
    expect(normalized && "events" in normalized ? normalized.events : []).toEqual([
      { kind: "permission-mode", at: Date.parse(ISO), mode: "ask" },
    ]);
  });

  it("says no mode for a record that is no turn's settings", () => {
    expect(codexModeEdge({ type: "event_msg", timestamp: ISO, "payload.approval_policy": "never" })).toBeNull();
  });
});
