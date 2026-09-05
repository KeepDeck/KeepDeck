import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/app", () => ({ fetchAppInfo: vi.fn() }));

import { fetchAppInfo, type AppInfo } from "../ipc/app";
import { readAppInfo, resetAppInfo } from "./appInfo";

const info: AppInfo = { name: "KeepDeck", version: "0.21.33", updater: false };
const shell = vi.mocked(fetchAppInfo);

beforeEach(() => {
  resetAppInfo();
  shell.mockReset();
});

describe("readAppInfo", () => {
  it("asks the shell once, however many readers ask", async () => {
    shell.mockResolvedValue(info);
    const [a, b, c] = await Promise.all([readAppInfo(), readAppInfo(), readAppInfo()]);
    expect([a, b, c]).toEqual([info, info, info]);
    expect(shell).toHaveBeenCalledTimes(1);
    await readAppInfo();
    expect(shell).toHaveBeenCalledTimes(1);
  });

  it("does not keep a failed read — the next reader asks the shell again", async () => {
    // Outside the tauri shell the first read fails; a cached rejection would
    // make every later reader fail too, after the shell came up.
    shell.mockRejectedValueOnce(new Error("no bridge")).mockResolvedValue(info);
    await expect(readAppInfo()).rejects.toThrow("no bridge");
    await expect(readAppInfo()).resolves.toEqual(info);
    expect(shell).toHaveBeenCalledTimes(2);
  });
});
