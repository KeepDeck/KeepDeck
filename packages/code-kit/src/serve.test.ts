import { afterEach, describe, expect, it, vi } from "vitest";
import { serve } from "./serve";
import type { HighlightReply } from "./protocol";

/** serve's subject is the protocol — which request reaches the engine, and
 * what goes back under which id — so the engine is a stand-in here. What a
 * real grammar makes of a text is engine.test's. */
const engine = vi.hoisted(() => ({
  tokenize: vi.fn<(text: string, lang: string) => Promise<unknown>>(),
  warm: vi.fn<(lang: string | null) => Promise<void>>(),
}));
vi.mock("./engine", () => engine);

/** One request served, its reply awaited. */
function ask(data: unknown): Promise<HighlightReply> {
  return new Promise((resolve) => serve(data, resolve));
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("serve", () => {
  it("answers a tokenize under its own id with what the engine made of it", async () => {
    const lines = [[{ text: "const", color: "#c678dd" }]];
    engine.tokenize.mockResolvedValueOnce(lines).mockResolvedValueOnce(null);

    expect(await ask({ kind: "tokenize", id: 7, text: "const", lang: "typescript" })).toEqual({ id: 7, lines });
    expect(engine.tokenize).toHaveBeenLastCalledWith("const", "typescript");
    // A language the kit didn't load: the engine's null, passed on as is.
    expect(await ask({ kind: "tokenize", id: 8, text: "x", lang: "brainfuck" })).toEqual({ id: 8, lines: null });
  });

  it("answers a failed tokenize with the failure, under its id", async () => {
    engine.tokenize.mockRejectedValueOnce(new Error("wasm failed to load"));
    expect(await ask({ kind: "tokenize", id: 9, text: "x", lang: "typescript" })).toEqual({
      id: 9,
      error: "wasm failed to load",
    });
  });

  it("warms on a warm-up and sends no reply for it, nor for a message that is not a request", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    engine.warm.mockRejectedValueOnce(new Error("no wasm"));
    const reply = vi.fn();

    serve({ kind: "warm", lang: "rust" }, reply);
    serve({ kind: "tokenize", id: "x" }, reply);
    serve("noise", reply);
    // The failed warm-up settles: said on the console, answered to no one.
    await vi.waitFor(() => expect(warned).toHaveBeenCalled());

    expect(engine.warm).toHaveBeenCalledWith("rust");
    expect(engine.tokenize).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });
});
