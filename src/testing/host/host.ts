// The page's tests on the real host: the app itself (kd-host, on Tauri's
// test runtime) in a process of its own, with a fresh home per test. The one
// stand-in is the transport — a pipe instead of a window's IPC — behind
// Tauri's own `mockIPC` seam, so the page's `invoke`, `Channel` and `listen`
// run as they are.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
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

/** What to hold: a request by its command before it reaches the host; the
 * host's reply to a command before it reaches the page; or the first
 * message on a channel that carries `heard` — and, the channel delivering in
 * order, every later one on it with it. */
export type Hold = { request: string } | { reply: string } | { heard: string };

/** Messages held until released, in their order. */
export interface Held {
  /** Settles once a first matching message is held. */
  caught: Promise<void>;
  /** Let everything held go, and hold nothing more. */
  release(): void;
}

/** How the app ends before it is launched again: quit as the person quits
 * it — its sessions stopped, its work left as it stands — or crashed:
 * killed, nothing of it finishing. */
export type Ending = "quit" | "crash";

export interface Host {
  /** The test's own KeepDeck home. */
  home: string;
  /** The process id of the app's current launch. */
  pid(): number;
  /** A folder for the test's workspaces and repositories. */
  work: string;
  /** A folder for the worktrees the test's teams are given. */
  trees: string;
  tape: TapeLine[];
  /** Where on the tape the app's current launch begins. */
  launchedAt(): number;
  hold(what: Hold): Held;
  /** Fail every call of `cmd` at the transport — the IPC broken under it,
   * the app never reached — until the answer is called. */
  fail(cmd: string): () => void;
  /** Wait for `ok` to hold, polling — a question to the app is awaited
   * before the next; fail as "never: `label`" past `ms`. */
  until(label: string, ok: () => boolean | Promise<boolean>, ms?: number): Promise<void>;
  /** Whether the machine's journal holds no operation: nothing it began is
   * still owed. A row that ends on what an operation did on disk — a folder
   * or a branch gone — ends here too: git runs in its own process group, so
   * a command the operation still waits on outlives kd-host's quit and goes
   * on writing into the repository the teardown removes. */
  journalEmpty(): boolean;
  /** End the app as `how` says, and launch it again on the same home and
   * folders — `meanwhile` run while it is down, as what changes on disk
   * between two launches. The page it served is gone with it: start a deck
   * anew. */
  relaunch(how: Ending, meanwhile?: () => void): Promise<void>;
  stop(): Promise<void>;
}

interface Holding {
  what: Hold;
  queued: (() => void)[];
  caught: () => void;
  released: boolean;
}

/** One launch of the app: its process, and when it has exited. */
interface Launch {
  child: ChildProcessWithoutNullStreams;
  exited: Promise<void>;
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

/** Every call of `cmd` the page made, from `mark` on the tape, in their
 * order: its id on the pipe, and its arguments. */
function asked(host: Pick<Host, "tape">, cmd: string, mark: number): { id: unknown; args: unknown }[] {
  const calls: { id: unknown; args: unknown }[] = [];
  for (const { way, line } of host.tape.slice(mark)) {
    if (way !== "page →" || !line.includes(`"cmd":"${cmd}"`)) continue;
    const call: unknown = JSON.parse(line);
    if (typeof call === "object" && call !== null && field(call, "cmd") === cmd) calls.push({ id: field(call, "id"), args: field(call, "args") });
  }
  return calls;
}

/** The arguments of every call of `cmd` the page made, from `mark` on the
 * tape, in their order. */
export function callsOf(host: Pick<Host, "tape">, cmd: string, mark = 0): unknown[] {
  return asked(host, cmd, mark).map(({ args }) => args);
}

/** The arguments of every call of `cmd` from `mark` on that the app has
 * answered. */
export function repliedTo(host: Pick<Host, "tape">, cmd: string, mark = 0): unknown[] {
  const answered = (id: unknown) => host.tape.some(({ way, line }) => way === "← host" && line.startsWith(`{"id":${String(id)},`));
  return asked(host, cmd, mark).filter(({ id }) => typeof id === "number" && answered(id)).map(({ args }) => args);
}

/** How long a quit has to end the app before it is killed — a little more
 * than its sessions' own stop. */
const QUIT_WAIT_MS = 10_000;

/** What a removal left in `folder`: the late writer's own files, named. */
function leftIn(folder: string): string {
  try {
    return readdirSync(folder, { recursive: true }).slice(0, 20).join(", ") || "nothing";
  } catch (error) {
    return `unreadable (${String(error)})`;
  }
}

/** Start the host on a fresh home and wait until the app's setup has run. */
export async function startHost(): Promise<Host> {
  if (typeof Reflect.get(globalThis, "window") === "undefined") Reflect.set(globalThis, "window", globalThis);
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kd-host-home-")));
  const work = realpathSync(mkdtempSync(join(tmpdir(), "kd-host-work-")));
  const trees = realpathSync(mkdtempSync(join(tmpdir(), "kd-host-trees-")));
  const started = performance.now();
  const tape: TapeLine[] = [];
  const note = (way: TapeLine["way"], line: string) => tape.push({ ms: Math.round(performance.now() - started), way, line });
  const replies = new Map<number, { cmd: string; settle(reply: object): void }>();
  const listeners = new Map<string, number[]>();
  const holdings: Holding[] = [];
  let nextId = 0;
  let nextEvent = 0;
  let launchedAt = 0;
  /** Whether the app is up to be written to: not between an end and the
   * launch after it. */
  let running = false;
  /** The commands whose calls fail at the transport, as an IPC that broke
   * fails them. */
  const failing = new Set<string>();

  /** Write a line to the app, if it is up; whether it was. */
  function write(line: string): boolean {
    if (!running) return false;
    current.child.stdin.write(`${line}\n`);
    return true;
  }

  /** Run `go` now, or queue it on the first holding it matches. */
  function through(matches: (what: Hold) => boolean, go: () => void): void {
    const holding = holdings.find((candidate) => !candidate.released && matches(candidate.what));
    if (!holding) return go();
    holding.queued.push(go);
    holding.caught();
  }

  /** Launch the app on the test's home, and wait until its setup has run. */
  async function launch(): Promise<Launch> {
    launchedAt = tape.length;
    const child = spawn(inject("hostBinary"), [], { env: { ...process.env, KEEPDECK_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    // A pipe to a process killed under it breaks: said on the tape, not
    // thrown into the test.
    child.stdin.on("error", (error) => note("host log", `the pipe to the app broke: ${String(error)}`));
    let readySignal = () => {};
    const ready = new Promise<void>((resolve) => (readySignal = resolve));
    createInterface({ input: child.stderr }).on("line", (line) => note("host log", line));
    createInterface({ input: child.stdout }).on("line", (line) => {
      note("← host", line);
      let said: unknown;
      try {
        said = JSON.parse(line);
      } catch (error) {
        // A kill ends the app wherever it is, mid-line included: the last
        // line it cut is no message. Any other line that does not read is
        // the wire broken.
        if (child.killed && child.stdout.readableEnded) return;
        throw error;
      }
      if (typeof said !== "object" || said === null) return;
      if (field(said, "ready") === true) return readySignal();
      const channel = field(said, "channel");
      if (typeof channel === "number") {
        return through(
          (what) => "heard" in what && line.includes(what.heard),
          () => runCallback(channel, { index: field(said, "index"), message: field(said, "message") }),
        );
      }
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
    const failed = new Promise<never>((_, reject) => child.once("error", reject));
    await Promise.race([ready, failed, exited.then(() => Promise.reject(new Error(`kd-host exited before it was ready:\n${tapeText(tape)}`)))]);
    running = true;
    return { child, exited };
  }

  /** End the current launch as `how` says; whether it ended in time. */
  async function end(how: Ending): Promise<boolean> {
    running = false;
    // What was held for this launch goes with it, unsent.
    for (const holding of holdings.splice(0)) {
      holding.released = true;
      holding.queued.length = 0;
    }
    if (how === "crash") {
      current.child.kill("SIGKILL");
      await current.exited;
      return true;
    }
    current.child.stdin.end();
    const ended = await Promise.race([current.exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), QUIT_WAIT_MS))]);
    if (!ended) current.child.kill("SIGKILL");
    return ended;
  }

  let current = await launch();

  mockIPC((cmd, args) => {
    const payload: Record<string, unknown> = typeof args === "object" && args !== null && !Array.isArray(args) ? { ...args } : {};
    // The event plugin: the page's own listen names the event, and the host
    // is asked to forward it — no list of event names is kept anywhere.
    // On the tape as the page asks them: what it listens to, and lets go of.
    if (cmd === "plugin:event|listen" || cmd === "plugin:event|unlisten") note("page →", JSON.stringify({ cmd, args: payload }));
    if (cmd === "plugin:event|listen") {
      const event = text(payload.event);
      const handler = Number(payload.handler);
      if (!listeners.has(event)) {
        const line = JSON.stringify({ watch: event });
        note("page →", line);
        write(line);
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
    if (failing.has(cmd)) {
      note("page →", JSON.stringify({ cmd, failed: "the IPC failed" }));
      return Promise.reject(new Error(`the IPC failed: ${cmd}`));
    }
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
          // An app that is down answers nothing: said as the failure it is.
          if (!write(line)) {
            replies.delete(id);
            reject(new Error(`the app is not running: ${cmd}`));
          }
        },
      );
    });
  });

  return {
    home,
    pid: () => current.child.pid ?? -1,
    work,
    trees,
    tape,
    launchedAt: () => launchedAt,
    journalEmpty: () => readdirSync(join(home, "lifecycle")).every((name) => !name.startsWith("op-")),
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
    fail(cmd) {
      failing.add(cmd);
      return () => failing.delete(cmd);
    },
    async until(label, ok, ms = 5000) {
      const start = performance.now();
      while (!(await ok())) {
        if (performance.now() - start > ms) throw new Error(`never: ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    async relaunch(how, meanwhile) {
      if (!(await end(how))) throw new Error(`kd-host did not quit within ${QUIT_WAIT_MS} ms`);
      meanwhile?.();
      // The page that heard the old launch is gone: nothing it waited on or
      // listened for carries over.
      replies.clear();
      listeners.clear();
      note("host log", `— ${how === "crash" ? "crashed" : "quit"}; launched again on the same home —`);
      current = await launch();
    },
    async stop() {
      const ended = await end("quit");
      clearMocks();
      const unremoved = [home, work, trees].flatMap((folder) => {
        try {
          rmSync(folder, { recursive: true, force: true });
          return [];
        } catch (error) {
          return [`${String(error)}; still in it: ${leftIn(folder)}`];
        }
      });
      // Whether the app had ended comes first: a folder written to under a
      // live app is that, not a late writer.
      if (!ended) throw new Error([`kd-host did not end within ${QUIT_WAIT_MS} ms of its pipe closing`, ...unremoved].join("\n"));
      if (unremoved.length > 0) throw new Error(["something wrote into a test folder after kd-host had ended:", ...unremoved].join("\n"));
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
