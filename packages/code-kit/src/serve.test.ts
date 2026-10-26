import { describe, expect, it, vi } from "vitest";
import { serve } from "./serve";
import type { HighlightReply } from "./protocol";

/** One request served, its reply awaited. */
function ask(data: unknown): Promise<HighlightReply> {
  return new Promise((resolve) => serve(data, resolve));
}

describe("serve", { timeout: 60_000 }, () => {
  it("answers a tokenize with its id, null for a language the kit didn't load", async () => {
    const colored = await ask({ kind: "tokenize", id: 7, text: "const a = 1", lang: "typescript" });
    expect(colored.id).toBe(7);
    expect("lines" in colored && colored.lines?.[0].length).toBeGreaterThan(1);
    expect(await ask({ kind: "tokenize", id: 8, text: "x", lang: "brainfuck" })).toEqual({ id: 8, lines: null });
  });

  it("sends no reply for a warm-up or a message that is not a request", async () => {
    const reply = vi.fn();
    serve({ kind: "warm", lang: "rust" }, reply);
    serve({ kind: "tokenize", id: "x" }, reply);
    serve("noise", reply);
    // The warm-up's own compile settles before a later tokenize is answered.
    await ask({ kind: "tokenize", id: 1, text: "fn main() {}", lang: "rust" });
    expect(reply).not.toHaveBeenCalled();
  });
});
