/**
 * Workers for a test realm, which has none — without one the client renders
 * plain. Install one before the first highlight: the client spawns its
 * worker on first use and keeps it for the module's life.
 */
import { vi } from "vitest";
import { serve } from "./serve";
import { isHighlightRequest, type HighlightReply } from "./protocol";
import type { LineTokens } from "./tokens";

/**
 * For tests about the colors themselves — what a real grammar makes of a
 * text: a `Worker` that runs the worker's own handler (serve.ts) in-process,
 * on the next task. Its first request compiles real grammars on the test's
 * own thread.
 */
class InProcessWorker extends EventTarget {
  postMessage(data: unknown): void {
    setTimeout(() => {
      serve(data, (reply) => this.dispatchEvent(new MessageEvent("message", { data: reply })));
    }, 0);
  }
  terminate(): void {}
}

export function installInProcessWorker(): void {
  vi.stubGlobal("Worker", InProcessWorker);
}

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
    const reply: HighlightReply = { id, lines: text.split("\n").map(runs) };
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: reply })));
  }
  terminate(): void {}
}

/**
 * For tests of a surface that shows code, where colors are input rather than
 * the subject: a `Worker` that answers each tokenize on the next microtask,
 * every word and every gap a run of its own color. The real client, hook and
 * spans run around it; no grammar compiles, so a colored row costs a flush,
 * not a clock.
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

/** A line as runs — each word and each gap its own, colored by position. */
function runs(line: string): LineTokens {
  return line
    .split(/(\s+)/)
    .filter((text) => text !== "")
    .map((text, index) => ({ text, color: `#${index.toString(16).padStart(6, "0")}` }));
}
