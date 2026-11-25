import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The `pty_open` wire contract with src-tauri/src/session_machine. The spec
 * object's KEYS are serde struct fields (camelCase via the struct's
 * rename_all), NOT command parameters — Tauri's own case conversion never
 * touches them, and a mismatched key with a serde default fails silently
 * (the shipped `envDefaults` bug: opencode skills died without an error).
 * The Rust side pins the same shape in session.rs's deserialization test.
 */
const tauri = vi.hoisted(() => {
  const channels: { onmessage: ((event: unknown) => void) | null }[] = [];
  return {
    invoke: vi.fn(async (_command: string, _args?: Record<string, unknown>): Promise<unknown> => 7),
    channels,
    channel: class {
      onmessage: ((event: unknown) => void) | null = null;
      constructor() {
        channels.push(this);
      }
    },
  };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, Channel: tauri.channel }));

import { openSession } from "./session";

const PANE = { kind: "pane", pane: "pane-3" } as const;

describe("the pty_open wire contract", () => {
  beforeEach(() => {
    tauri.invoke.mockClear();
    tauri.invoke.mockResolvedValue(7);
  });

  it("pins the spec's exact field keys, envDefaults included, beside the permit and the owner", async () => {
    await openSession(
      {
        command: "opencode",
        args: ["-s", "x"],
        env: [["A", "1"]],
        envDefaults: [["OPENCODE_CONFIG_DIR", "/kd/opencode/ws-1"]],
        cwd: "/repo",
        cols: 80,
        rows: 24,
        secrets: ["s-mcp", "s-bridge"],
      },
      41,
      PANE,
      () => {},
    );
    expect(tauri.invoke).toHaveBeenCalledWith("pty_open", {
      spec: {
        command: "opencode",
        args: ["-s", "x"],
        env: [["A", "1"]],
        envDefaults: [["OPENCODE_CONFIG_DIR", "/kd/opencode/ws-1"]],
        cwd: "/repo",
        cols: 80,
        rows: 24,
        secrets: ["s-mcp", "s-bridge"],
      },
      permit: 41,
      owner: PANE,
      onEvent: expect.anything(),
    });
  });

  it("omitted optionals cross the wire as their explicit defaults", async () => {
    await openSession({ cols: 1, rows: 1 }, 1, PANE, () => {});
    expect(tauri.invoke.mock.calls[0][1]?.spec).toEqual({
      command: null,
      args: [],
      env: [],
      envDefaults: [],
      cwd: null,
      cols: 1,
      rows: 1,
      secrets: [],
    });
  });

  it("addresses the session it opened for input, size and the exact stop", async () => {
    const session = await openSession({ cols: 1, rows: 1 }, 1, PANE, () => {});
    await session.write("hi");
    await session.resize(100, 30);
    await session.stop();
    expect(tauri.invoke).toHaveBeenCalledWith("pty_write", { id: 7, data: [104, 105] });
    expect(tauri.invoke).toHaveBeenCalledWith("pty_resize", { id: 7, cols: 100, rows: 30 });
    expect(tauri.invoke).toHaveBeenLastCalledWith("pty_stop", { id: 7 });
  });
});

describe("a session's output on the wire", () => {
  it("arrives as base64 and reaches the consumer as the bytes it encodes", async () => {
    const seen: unknown[] = [];
    await openSession({ cols: 80, rows: 24 }, 1, PANE, (event) => seen.push(event));
    const deliver = tauri.channels[tauri.channels.length - 1]?.onmessage;
    if (!deliver) throw new Error("openSession opened no channel");
    deliver({ type: "output", data: btoa("\u001b[31mhi") });
    deliver({ type: "exit", success: true, code: 0 });
    expect(seen).toEqual([
      { type: "output", bytes: Uint8Array.from([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x68, 0x69]) },
      { type: "exit", success: true, code: 0 },
    ]);
  });
});
