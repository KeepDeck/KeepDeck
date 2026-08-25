/**
 * A stand-in deck for the reporter suites.
 *
 * The reporters used to be testable by looking in a directory: they wrote a
 * file, and the test read it back. Since the cutoff they post to the deck, so
 * a test that wants to see what a reporter said has to be something a
 * reporter can post TO.
 *
 * Shared rather than copied into each plugin's suite for the reason the
 * reporters themselves are: four copies of one stand-in is four chances for
 * one of them to answer differently from the deck.
 */
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Start one. `answer` decides what to reply with, given the envelope just
 * received — default 204, which is what the deck says when a report needs
 * nothing back and is what every non-asking reporter gets.
 *
 * The server runs in the TEST's process, so a reporter must be run with the
 * async `execFile`: a synchronous spawn blocks this event loop, and the
 * request would never be served by the process waiting for it.
 */
/** What the stand-in deck answers one envelope with. */
export interface DeckAnswer {
  status: number;
  body?: string;
}

export async function startDeck(
  answer: (envelope: any, nth: number) => DeckAnswer | undefined = () => ({
    status: 204,
  }),
) {
  /** Every envelope posted, parsed. Raw text if it would not parse — a
   * reporter emitting malformed JSON is a failure worth SEEING rather than
   * one that disappears into a catch. */
  const envelopes: any[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = { unparseable: body };
      }
      envelopes.push(parsed);
      const reply = answer(parsed, envelopes.length) ?? { status: 204 };
      const headers = reply.body
        ? { "content-type": "text/plain; charset=utf-8" }
        : {};
      response.writeHead(reply.status, headers);
      response.end(reply.body ?? "");
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/envelope`,
    envelopes,
    /**
     * Wait until `count` envelopes have arrived.
     *
     * A reporter that fires and forgets used to be testable the instant it
     * returned, because its write was synchronous. A post is not, and a test
     * that asserted straight after the call would be asserting on a request
     * still in flight. Explicit rather than a sleep: a count is what the test
     * actually means, and it fails with the count it got.
     */
    waitFor: async (count: number, timeoutMs = 2000) => {
      const until = Date.now() + timeoutMs;
      while (envelopes.length < count) {
        if (Date.now() > until) {
          throw new Error(
            `waited ${timeoutMs}ms for ${count} envelope(s), got ${envelopes.length}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return envelopes;
    },
    /** Give anything already in flight time to land — for asserting that
     * NOTHING was reported, where there is no count to wait for. */
    idle: () => new Promise((resolve) => setTimeout(resolve, 40)),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Run one reporter against a deck, the way a spawned pane runs it.
 *
 * Stdin comes from a FILE, never a pipe. The scripts check their
 * preconditions and exit BEFORE reading stdin, so a guard that exits first
 * closes the read end under a writing harness and the HARNESS fails with
 * EPIPE although the reporter itself succeeded.
 *
 * `dir` is still handed over because `KEEPDECK_BRIDGE` still carries it — it
 * is where the deck's doorbell lands — but no reporter writes there any more,
 * which is what `leaves nothing behind in the run directory` checks.
 */
export interface RunOptions {
  url?: string;
  stdin?: string | Buffer;
  args?: string[];
  dir?: string;
  env?: Record<string, string | undefined>;
  armed?: boolean;
  baseEnv?: Record<string, string | undefined>;
}

export function runReporter(
  script: string,
  { url, stdin = "", args = [], dir, env = {}, armed = true, baseEnv }: RunOptions,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const scratch = mkdtempSync(join(tmpdir(), "kd-reporter-run-"));
  const payload = join(scratch, "stdin");
  writeFileSync(payload, stdin);
  const fd = openSync(payload, "r");
  return new Promise((resolve) => {
    // `spawn`, not `execFile`: only spawn honours an explicit `stdio` array,
    // and execFile given one hangs instead of saying so.
    const child = spawn("/bin/sh", [script, ...args], {
      stdio: [fd, "pipe", "pipe"],
      env: ({
        // `baseEnv` for a suite that composes the whole environment itself —
        // HOME isolation, deleted vars — where inheriting this process's
        // would make the assertions machine-dependent.
        ...(baseEnv ?? process.env),
        ...env,
        // `armed: false` is a pane KeepDeck did not spawn. The var is absent
        // rather than empty: an empty one is a different case (a deck that
        // published nothing), and a reporter may tell them apart.
        ...(armed
          ? {
              KEEPDECK_BRIDGE: JSON.stringify({
                v: 2,
                dir: dir ?? scratch,
                pane: "pane-3",
                token: "tok",
                url,
              }),
            }
          : {}),
      } as NodeJS.ProcessEnv),
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (code) => {
      closeSync(fd);
      rmSync(scratch, { recursive: true, force: true });
      resolve({ stdout, stderr, code });
    });
  });
}
