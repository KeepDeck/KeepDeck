import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The `session_spawn` wire contract with src-tauri/src/session.rs. The spec
 * object's KEYS are serde struct fields (camelCase via the struct's
 * rename_all), NOT command parameters — Tauri's own case conversion never
 * touches them, and a mismatched key with a serde default fails silently
 * (the shipped `envDefaults` bug: opencode skills died without an error).
 * This pins the exact spec shape the webview sends; the Rust side pins the
 * same shape in session.rs's deserialization test.
 */
const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async (): Promise<unknown> => "session-1"),
  channel: class {
    onmessage: unknown;
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
  Channel: tauri.channel,
}));

import { spawnSession } from "./session";

describe("the session_spawn wire contract", () => {
  beforeEach(() => {
    tauri.invoke.mockClear();
    tauri.invoke.mockResolvedValue("session-1");
  });

  it("pins the spec's exact field keys, envDefaults included", async () => {
    await spawnSession(
      {
        command: "opencode",
        args: ["-s", "x"],
        env: [["A", "1"]],
        envDefaults: [["OPENCODE_CONFIG_DIR", "/kd/opencode/ws-1"]],
        cwd: "/repo",
        cols: 80,
        rows: 24,
      },
      () => {},
    );

    expect(tauri.invoke).toHaveBeenCalledWith("session_spawn", {
      spec: {
        command: "opencode",
        args: ["-s", "x"],
        env: [["A", "1"]],
        envDefaults: [["OPENCODE_CONFIG_DIR", "/kd/opencode/ws-1"]],
        cwd: "/repo",
        cols: 80,
        rows: 24,
      },
      onEvent: expect.anything(),
    });
  });

  it("omitted optionals cross the wire as their explicit defaults", async () => {
    await spawnSession({ cols: 1, rows: 1 }, () => {});
    const [, payload] = tauri.invoke.mock.calls[0] as unknown as [
      string,
      { spec: object },
    ];
    expect(payload.spec).toEqual({
      command: null,
      args: [],
      env: [],
      envDefaults: [],
      cwd: null,
      cols: 1,
      rows: 1,
    });
  });
});
