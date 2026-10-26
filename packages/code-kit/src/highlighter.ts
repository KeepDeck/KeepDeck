/**
 * The main thread's side of highlighting: a client of the highlight worker
 * (worker.ts), which owns the one Shiki instance this bundle has. Nothing here
 * compiles or tokenizes — a grammar's cold compile is one uninterruptible task
 * of up to ~650 ms, and on the main thread that is a frozen UI however it is
 * scheduled. The main thread sends text and receives colored runs.
 *
 * One worker per bundle, spawned on first use. A realm without workers gets
 * no highlighting — the text renders plain, as for an unknown language.
 *
 * A worker that fails — it crashed, or it left a request unanswered past
 * `REPLY_DEADLINE_MS` (the engine runs with no per-line time limit, so a
 * pathological input could hold it forever and every request queued behind
 * it) — is dropped with everything waiting on it, and the next request
 * spawns a fresh one. After `MAX_FAILURES` failures in a row with no answer
 * between them, highlighting stays off for the session: a document that
 * kills every worker would otherwise respawn one per render.
 */
import HighlightWorker from "./worker?worker&inline";
import { isHighlightReply, type HighlightRequest } from "./protocol";
import type { LineTokens } from "./tokens";

/** How long a tokenize may go unanswered. Far past any real document under
 * limits.ts — a whole cold file compiles in well under a second. */
export const REPLY_DEADLINE_MS = 30_000;

/** Failed workers in a row before highlighting gives up for the session. */
export const MAX_FAILURES = 3;

interface Pending {
  resolve: (lines: LineTokens[] | null) => void;
  reject: (cause: Error) => void;
  deadline: ReturnType<typeof setTimeout>;
}

let worker: Worker | null = null;
const pending = new Map<number, Pending>();
let nextId = 0;
let failures = 0;

/** Drop `failed` and everything waiting on it. */
function fail(failed: Worker, reason: string): void {
  if (worker !== failed) return;
  worker = null;
  failures++;
  failed.terminate();
  const waiting = [...pending.values()];
  pending.clear();
  for (const waiter of waiting) {
    clearTimeout(waiter.deadline);
    waiter.reject(new Error(`highlight worker failed: ${reason}`));
  }
}

/** The worker, spawned on first use — none in a realm without workers, or
 * once too many have failed. */
function getWorker(): Worker | null {
  if (typeof Worker === "undefined" || failures >= MAX_FAILURES) return null;
  if (worker) return worker;
  const spawned = new HighlightWorker();
  spawned.addEventListener("message", (event: MessageEvent<unknown>) => {
    const reply = event.data;
    if (!isHighlightReply(reply)) return;
    const waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id);
    clearTimeout(waiter.deadline);
    failures = 0;
    if ("error" in reply) waiter.reject(new Error(reply.error));
    else waiter.resolve(reply.lines);
  });
  spawned.addEventListener("error", (event) => {
    event.preventDefault();
    fail(spawned, event.message);
  });
  worker = spawned;
  return spawned;
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
  const target = getWorker();
  if (!target) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const deadline = setTimeout(
      () => fail(target, `no answer in ${REPLY_DEADLINE_MS / 1000}s`),
      REPLY_DEADLINE_MS,
    );
    pending.set(id, { resolve, reject, deadline });
    target.postMessage({ kind: "tokenize", id, text, lang } satisfies HighlightRequest);
  });
}

/** Have the worker pay its cold cost now — the instance, then `lang`'s
 * grammar when given — rather than on the first file a person opens. Free on
 * the main thread: one message. */
export function warmLanguage(lang: string | null): void {
  getWorker()?.postMessage({ kind: "warm", lang } satisfies HighlightRequest);
}
