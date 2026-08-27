import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The invoke-key contract with `src-tauri/src/exec_once.rs`. Everything
 * above this module mocks it, so nothing else exercises the actual command
 * name and argument keys — and a silent key mismatch here is invisible in
 * every test above and fails only in a running app. Same guard idiom as
 * skills.test.ts: mock the tauri boundary, run the real module, pin the
 * exact wire call.
 */
const tauri = vi.hoisted(() => ({
  invoke: vi.fn(
    async (_command: string, _args?: Record<string, unknown>): Promise<unknown> => ({
      ran: true,
      ok: true,
      said: "",
    }),
  ),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));

const { execRunOnce } = await import("./exec");

beforeEach(() => tauri.invoke.mockClear());

describe("execRunOnce", () => {
  it("calls exec_run_once with every field the Rust side names", async () => {
    await execRunOnce({
      key: "/cfg/ws-1",
      command: "opencode",
      args: ["models"],
      env: [["OPENCODE_CONFIG_DIR", "/cfg/ws-1"]],
    });

    expect(tauri.invoke).toHaveBeenCalledWith("exec_run_once", {
      key: "/cfg/ws-1",
      command: "opencode",
      args: ["models"],
      env: [["OPENCODE_CONFIG_DIR", "/cfg/ws-1"]],
    });
  });

  it("sends empty args and env rather than omitting them", async () => {
    // The Rust params are not optional: a missing key deserializes as an
    // error, not as a default, so the wire form must always carry both.
    await execRunOnce({ key: "k", command: "git" });

    expect(tauri.invoke).toHaveBeenCalledWith("exec_run_once", {
      key: "k",
      command: "git",
      args: [],
      env: [],
    });
  });

  it("hands back what the host answered", async () => {
    tauri.invoke.mockResolvedValueOnce({ ran: false, ok: false, said: "boom" });

    expect(await execRunOnce({ key: "k", command: "git" })).toEqual({
      ran: false,
      ok: false,
      said: "boom",
    });
  });
});
