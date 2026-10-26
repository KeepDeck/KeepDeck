/**
 * What the highlight worker does with one message: the engine (engine.ts)
 * behind the protocol (protocol.ts). Apart from worker.ts so the worker's
 * entry stays the port wiring alone, and a test realm without workers can run
 * this very handler in-process (testing.ts).
 *
 * Requests are served in arrival order, one at a time — the engine is
 * synchronous per call — so a warm-up queued ahead of a tokenize delays it by
 * at most that one grammar.
 */
import { tokenize, warm } from "./engine";
import { isHighlightRequest, type HighlightReply } from "./protocol";

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function serve(data: unknown, reply: (message: HighlightReply) => void): void {
  if (!isHighlightRequest(data)) return;
  if (data.kind === "warm") {
    const { lang } = data;
    warm(lang).catch((cause: unknown) => {
      console.warn(`code-kit: warming ${lang ?? "the highlighter"} failed:`, cause);
    });
    return;
  }
  const { id, text, lang } = data;
  tokenize(text, lang).then(
    (lines) => reply({ id, lines }),
    (cause: unknown) => reply({ id, error: errorText(cause) }),
  );
}
