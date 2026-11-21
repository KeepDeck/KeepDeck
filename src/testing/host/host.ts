// The page's tests on the real host: the app itself (kd-host, on Tauri's
// test runtime) in a process of its own, with a fresh home per test. The one
// stand-in is the transport — a pipe instead of a window's IPC — behind
// Tauri's own `mockIPC` seam, so the page's `invoke`, `Channel` and `listen`
// run as they are.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, inject } from "vitest";
import "./build";

/** One line of the pipe or the host's log, with its time since the start. */
export interface TapeLine {
  ms: number;
  way: "page →" | "← host" | "host log" | "page log";
  line: string;
}

/** What to hold: a request by its command before it reaches the host, or
 * the host's reply to a command before it reaches the page. */
export type Hold = { request: string } | { reply: string };

/** Messages held until released, in their order. */
export interface Held {
  /** Settles once a first matching message is held. */
  caught: Promise<void>;
  /** Let everything held go, and hold nothing more. */
  release(): void;
}

export interface Host {
  /** The test's own KeepDeck home. */
  home: string;
  /** A folder for the test's workspaces and repositories. */
  work: string;
  tape: TapeLine[];
  hold(what: Hold): Held;
  /** Wait for `ok` to hold, polling; fail as "never: `label`" past `ms`. */
  until(label: string, ok: () => boolean, ms?: number): Promise<void>;
  stop(): Promise<void>;
}

interface Holding {
  what: Hold;
  queued: (() => void)[];
  caught: () => void;
  released: boolean;
}

/** The Tauri internals `mockIPC` installs: channel and event callbacks. */
function runCallback(id: number, data: unknown): void {
  const internals: unknown = Reflect.get(globalThis, "__TAURI_INTERNALS__");
  if (typeof internals !== "object" || internals === null || !("runCallback" in internals) || typeof internals.runCallback !== "function") {
    throw new Error("no Tauri internals: mockIPC is not installed");
  }
  Reflect.apply(internals.runCallback, internals, [id, data]);
}

function field(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Start the host on a fresh home and wait until the app's setup has run. */
export async function startHost(): Promise<Host> {
  if (typeof Reflect.get(globalThis, "window") === "undefined") Reflect.set(globalThis, "window", globalThis);
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kd-host-home-")));
  const work = realpathSync(mkdtempSync(join(tmpdir(), "kd-host-work-")));
  const child: ChildProcessWithoutNullStreams = spawn(inject("hostBinary"), [], {
    env: { ...process.env, KEEPDECK_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const started = performance.now();
  const tape: TapeLine[] = [];
  const note = (way: TapeLine["way"], line: string) => tape.push({ ms: Math.round(performance.now() - started), way, line });
  const replies = new Map<number, { cmd: string; settle(reply: object): void }>();
  const listeners = new Map<string, number[]>();
  const holdings: Holding[] = [];
  let nextId = 0;
  let nextEvent = 0;
  let readySignal = () => {};
  const ready = new Promise<void>((resolve) => (readySignal = resolve));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

  /** Run `go` now, or queue it on the first holding it matches. */
  function through(matches: (what: Hold) => boolean, go: () => void): void {
    const holding = holdings.find((candidate) => !candidate.released && matches(candidate.what));
    if (!holding) return go();
    holding.queued.push(go);
    holding.caught();
  }

  createInterface({ input: child.stderr }).on("line", (line) => note("host log", line));
  createInterface({ input: child.stdout }).on("line", (line) => {
    note("← host", line);
    const said: unknown = JSON.parse(line);
    if (typeof said !== "object" || said === null) return;
    if (field(said, "ready") === true) return readySignal();
    const channel = field(said, "channel");
    if (typeof channel === "number") return runCallback(channel, { index: field(said, "index"), message: field(said, "message") });
    const event = field(said, "event");
    if (typeof event === "string") {
      for (const handler of listeners.get(event) ?? []) runCallback(handler, { event, payload: field(said, "payload"), id: ++nextEvent });
      return;
    }
    const id = field(said, "id");
    if (typeof id !== "number") return;
    const waiting = replies.get(id);
    if (!waiting) return;
    replies.delete(id);
    through((what) => "reply" in what && what.reply === waiting.cmd, () => waiting.settle(said));
  });

  mockIPC((cmd, args) => {
    const payload: Record<string, unknown> = typeof args === "object" && args !== null && !Array.isArray(args) ? { ...args } : {};
    // The event plugin: the page's own listen names the event, and the host
    // is asked to forward it — no list of event names is kept anywhere.
    if (cmd === "plugin:event|listen") {
      const event = text(payload.event);
      const handler = Number(payload.handler);
      if (!listeners.has(event)) {
        const line = JSON.stringify({ watch: event });
        note("page →", line);
        child.stdin.write(`${line}\n`);
      }
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      return Promise.resolve(handler);
    }
    if (cmd === "plugin:event|unlisten") {
      const event = text(payload.event);
      listeners.set(event, (listeners.get(event) ?? []).filter((handler) => handler !== Number(payload.eventId)));
      return Promise.resolve();
    }
    // The page's log goes on the tape.
    if (cmd.startsWith("plugin:log|")) {
      note("page log", text(payload.message));
      return Promise.resolve();
    }
    // The window shell's plugins (dialogs, the clipboard, the updater) have
    // no window here: said as a refusal, never answered as if they did.
    if (cmd.startsWith("plugin:")) return Promise.reject(new Error(`no window shell in the host: ${cmd}`));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      replies.set(id, {
        cmd,
        settle: (reply) => ("error" in reply ? reject(field(reply, "error")) : resolve(field(reply, "ok"))),
      });
      // JSON.stringify writes a Channel as "__CHANNEL__:<id>", as Tauri's IPC does.
      const line = JSON.stringify({ id, cmd, args: payload });
      through(
        (what) => "request" in what && what.request === cmd,
        () => {
          note("page →", line);
          child.stdin.write(`${line}\n`);
        },
      );
    });
  });

  const failed = new Promise<never>((_, reject) => child.once("error", reject));
  await Promise.race([ready, failed, exited.then(() => Promise.reject(new Error(`kd-host exited before it was ready:\n${tapeText(tape)}`)))]);

  return {
    home,
    work,
    tape,
    hold(what) {
      let caught = () => {};
      const holding: Holding = { what, queued: [], caught: () => caught(), released: false };
      const promise = new Promise<void>((resolve) => (caught = resolve));
      holdings.push(holding);
      return {
        caught: promise,
        release() {
          holding.released = true;
          for (const go of holding.queued.splice(0)) go();
        },
      };
    },
    async until(label, ok, ms = 5000) {
      const start = performance.now();
      while (!ok()) {
        if (performance.now() - start > ms) throw new Error(`never: ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    async stop() {
      for (const holding of holdings) holding.released = true;
      child.stdin.end();
      const ended = await Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000))]);
      if (!ended) child.kill("SIGKILL");
      clearMocks();
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
      if (!ended) throw new Error("kd-host did not end within 10 s of its pipe closing");
    },
  };
}

/** The tape, one line each, as a failed test prints it. */
export function tapeText(tape: TapeLine[]): string {
  return tape.map(({ ms, way, line }) => `${String(ms).padStart(6)} ms  ${way.padEnd(8)}  ${line}`).join("\n");
}

/** A fresh host for each test of the calling file, stopped after it; a
 * failed test prints the host's tape. */
export function useHost(): () => Host {
  let host: Host | null = null;
  beforeEach(async () => {
    host = await startHost();
  });
  afterEach(async (context) => {
    const ended = host;
    host = null;
    if (!ended) return;
    if (context.task.result?.state === "fail") console.log(`the host's tape:\n${tapeText(ended.tape)}`);
    await ended.stop();
  });
  return () => {
    if (!host) throw new Error("no host: useHost's host lives inside a test");
    return host;
  };
}
