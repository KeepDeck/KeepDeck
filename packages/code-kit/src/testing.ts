/**
 * A worker for a test realm, which has none — without one the client renders
 * plain. Install it before the first highlight: the client spawns its worker
 * on first use and keeps it for the module's life.
 */
import { vi } from "vitest";
import { isHighlightRequest, type HighlightReply } from "./protocol";
import type { LineTokens } from "./tokens";

/** One tokenize the token worker was asked. */
export interface TokenRequest {
  text: string;
  lang: string;
}

/** Every tokenize the token worker was asked, in order. Module state, like
 * the client's one worker: whichever install spawned that worker, every
 * later one hands back this same record. */
const asked: TokenRequest[] = [];

class TokenWorker extends EventTarget {
  postMessage(data: unknown): void {
    if (!isHighlightRequest(data) || data.kind !== "tokenize") return;
    const { id, text, lang } = data;
    asked.push({ text, lang });
    const reply: HighlightReply = { id, lines: linesOf(text) };
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: reply })));
  }
  terminate(): void {}
}

/**
 * For tests of a surface that shows code, where colors are input rather than
 * the subject: a `Worker` that answers each tokenize on the next microtask,
 * every word and every gap a run of its own color, and everything from a
 * `/*` to its `*\/` in `STAND_IN_COMMENT` — carried from line to line of one
 * text, as a grammar carries it, so what a document READS AS can be tested
 * without one. The real client, hook and spans run around it; no grammar
 * compiles, so a colored row costs a flush, not a clock.
 *
 * Hands back the live record of what it was asked: what was colored, in
 * which language, is the one thing a stand-in that colors anything cannot
 * judge for itself. Safe to install before every test — the record outlives
 * each install, so a test reads its own asks as those added since it began.
 */
export function installTokenWorker(): readonly TokenRequest[] {
  vi.stubGlobal("Worker", TokenWorker);
  return asked;
}

/** The color the stand-in paints a block comment in — one no word's
 * positional color can be. */
export const STAND_IN_COMMENT = "#7f848e";

/** A text as lines of runs: each word and each gap its own, colored by its
 * position in the line, and a block comment in `STAND_IN_COMMENT` — its state
 * the one thing carried from a line to the next, within this text only. */
function linesOf(text: string): LineTokens[] {
  let inComment = false;
  return text.split("\n").map((line) => {
    const out: LineTokens = [];
    for (const piece of line.split(/(\/\*|\*\/)/)) {
      if (piece === "/*") inComment = true;
      for (const run of inComment ? [piece] : piece.split(/(\s+)/)) {
        if (run === "") continue;
        out.push({ text: run, color: inComment ? STAND_IN_COMMENT : `#${out.length.toString(16).padStart(6, "0")}` });
      }
      if (piece === "*/") inComment = false;
    }
    return out;
  });
}
