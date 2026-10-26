/**
 * The main thread's side of highlighting: a client of the highlight worker
 * (worker.ts), which owns the one Shiki instance this bundle has. Nothing here
 * compiles or tokenizes — a grammar's cold compile is one uninterruptible task
 * of up to ~650 ms, and on the main thread that is a frozen UI however it is
 * scheduled. The main thread sends text and receives colored runs.
 *
 * One worker per bundle, spawned on first use. A realm without workers gets
 * no highlighting — the text renders plain, as for an unknown language.
 */
import HighlightWorker from "./worker?worker&inline";
import { isHighlightReply, type HighlightRequest } from "./protocol";
import type { LineTokens } from "./tokens";

interface Pending {
  resolve: (lines: LineTokens[] | null) => void;
  reject: (cause: Error) => void;
}

let worker: Worker | null = null;
const pending = new Map<number, Pending>();
let nextId = 0;

/** The worker, spawned on first use. A worker that fails is dropped with
 * everything waiting on it; the next request spawns a fresh one. */
function getWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  if (worker) return worker;
  const spawned = new HighlightWorker();
  spawned.addEventListener("message", (event: MessageEvent<unknown>) => {
    const reply = event.data;
    if (!isHighlightReply(reply)) return;
    const waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id);
    if ("error" in reply) waiter.reject(new Error(reply.error));
    else waiter.resolve(reply.lines);
  });
  spawned.addEventListener("error", (event) => {
    event.preventDefault();
    if (worker === spawned) worker = null;
    spawned.terminate();
    const failed = [...pending.values()];
    pending.clear();
    for (const waiter of failed) {
      waiter.reject(new Error(`highlight worker failed: ${event.message}`));
    }
  });
  worker = spawned;
  return spawned;
}

function send(request: HighlightRequest): boolean {
  const target = getWorker();
  if (!target) return false;
  target.postMessage(request);
  return true;
}

/**
 * Tokenize `text` into per-line colored runs, aligned to `text.split("\n")`
 * (see tokens.ts for the alignment guarantees). `lang` may be a canonical id
 * (what `langFor` emits) or any grammar alias — "bash", "ts", "py" — which is
 * what a Markdown fence names. Null for a language the kit didn't load, or
 * where there is no worker to ask — the caller renders plain. Engine failures
 * reject; the caller decides how loudly to fall back.
 */
export function tokenizeLines(text: string, lang: string): Promise<LineTokens[] | null> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    if (!send({ kind: "tokenize", id, text, lang })) {
      pending.delete(id);
      resolve(null);
    }
  });
}

/** Have the worker pay its cold cost now — the instance, then `lang`'s
 * grammar when given — rather than on the first file a person opens. Free on
 * the main thread: one message. */
export function warmLanguage(lang: string | null): void {
  send({ kind: "warm", lang });
}
