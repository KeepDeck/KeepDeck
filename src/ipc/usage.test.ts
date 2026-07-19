import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async (): Promise<unknown> => ({ body: "{}", sourceAt: 123 })),
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));

import { fetchCodexRateLimits } from "./usage";

describe("the codex app-server usage wire contract", () => {
  beforeEach(() => {
    tauri.invoke.mockClear();
    tauri.invoke.mockResolvedValue({ body: "{}", sourceAt: 123 });
  });

  it("uses the narrow managed rate-limits command with no arbitrary RPC", async () => {
    await expect(fetchCodexRateLimits()).resolves.toEqual({
      body: "{}",
      sourceAt: 123,
    });
    expect(tauri.invoke).toHaveBeenCalledWith("codex_rate_limits_read");
  });
});
