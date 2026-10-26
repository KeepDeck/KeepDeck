import { describe, expect, it, vi } from "vitest";
import { tokenize } from "./engine";

/** A core that fails to come up once, then works: the WASM or a grammar
 * failing to load is the real-world shape. */
const create = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
vi.mock("@shikijs/core", () => ({ createHighlighterCore: create }));

describe("the engine's instance", () => {
  it("is created again after a failed creation, not failed for good", async () => {
    create
      .mockRejectedValueOnce(new Error("wasm failed to load"))
      .mockResolvedValueOnce({
        getLanguage: () => ({}),
        codeToTokens: () => ({ tokens: [[{ content: "x", offset: 0 }]] }),
      });
    await expect(tokenize("x", "typescript")).rejects.toThrow("wasm failed to load");
    await expect(tokenize("x", "typescript")).resolves.toEqual([[{ text: "x" }]]);
    expect(create).toHaveBeenCalledTimes(2);
  });
});
