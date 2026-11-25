// The stub agent: the program a pane runs in the page's tests on the host,
// standing in for an agent's CLI — which needs a network and an account. It
// does what the page depends on a CLI for, through the channels a CLI uses:
// it prints into its terminal, reports through the deck's bridge as a CLI's
// hooks do — its conversation bound, then itself at its prompt — and ends on
// a cue typed into its terminal or on a stop. Kept to that: every behaviour
// here is one the page reads.
//
// Arguments, from the stub plugin's plans:
//   --resume <id>  continue conversation <id>
//   --fork <id>    open a new conversation copied from <id>
//   --reject       refuse the resume or the fork: exit at once, having
//                  reported nothing
//   --deaf         ignore a polite stop (TERM), so only the kill ends it
//   --unbound      report nothing at start: what it reports is cued
//   --waiting      at start, say it waits on a permission rather than that
//                  it is at its prompt
//   --child        a process the agent started in its own terminal: it
//                  reports nothing of its own and takes its cues from the
//                  agent
//   --store <dir>  keep the conversation's file there, `<id>.jsonl`, as a
//                  CLI keeps its transcript, and name it in its binding
//   --linger <socket> <file> <agent pid>
//                  the daemon a `linger` cue starts: nothing else
//   --hook <json> <agent pid>
//                  the shell a `hook` cue starts, leading a session of its
//                  own as an agent's hook shell does: it runs the sender
//   --send <json> <agent pid>
//                  that shell's child, the hook itself: it posts the
//                  envelope and ends
//
// With KEEPDECK_STUB_LIVE set — a process run outside the deck's panes —
// it keeps a file named for its conversation in that folder while it runs:
// the stub plugin's registry of live sessions reads them, as a CLI's own
// registry knows its interactive runs.
//
// Cues, one per line typed into its terminal:
//   exit <code>    end with that code
//   say <text>     print the text
//   fill <n> <c>   print the character c, n times over, as one line
//   post <json>    send one envelope through the bridge, as a hook does:
//                  {type, paneId?, token?, payload?, cue?}. What it leaves
//                  out is the plan's — the pane and its token — and, in the
//                  payload, this agent's name and this process's id; then
//                  print `stub: posted <type> <the bridge's answer> <cue>`,
//                  the cue naming which post was answered
//   child <cue>    hand the cue to the process this one started in its
//                  terminal — started at the first such cue
//   hook <json>    send the envelope as an agent's hook does: from a child
//                  of a shell this agent started detached, in that shell's
//                  session, naming this agent as the reporting process — or
//                  itself, when the payload's reporter says `self`, as a
//                  daemon's worker does
//   record <json>  write one record to the conversation's file, as a CLI
//                  writes a line of its transcript; then print
//                  `stub: recorded <type>`
//   mcp <socket> <line>
//                  ask the deck's MCP socket one JSON-RPC line, greeting it
//                  with the pane's secret as an injected shim does; then
//                  print `stub: mcp <the one line that answers it>`
//   linger <socket> <file>
//                  start a process that leaves this terminal's session, as
//                  a daemon an agent starts does, and outlives the pane. It
//                  opens ONE connection greeted with the pane's secret, asks
//                  `initialize` on it while this agent runs and writes the
//                  answer to <file>.held; once this agent is gone it asks
//                  `tools/list` on the same connection and writes that answer
//                  to <file>. Print `stub: lingering`
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);

/** @param {string} name */
const flag = (name) => args.includes(name);

/** @param {string} name */
function valueOf(name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

/** @param {string} line */
const print = (line) => process.stdout.write(`${line}\r\n`);

/** The pane's bridge, as its process tree inherits it — its secret too. */
const armed = process.env.KEEPDECK_BRIDGE;
const bridge = armed ? JSON.parse(armed) : null;

/** A connection to the deck's MCP socket, greeted with `token` as an injected
 * shim greets it: each line asked is answered by the next line it sends.
 * @param {string} socket @param {string | undefined} token
 * @returns {Promise<{ ask(line: string): Promise<string>, close(): void }>} */
function openDeck(socket, token) {
  return new Promise((resolve, reject) => {
    const connection = connect(socket);
    /** @type {{ resolve(line: string): void, reject(error: Error): void }[]} */
    const waiting = [];
    let buffer = "";
    const fail = (/** @type {Error} */ error) => {
      for (const asker of waiting.splice(0)) asker.reject(error);
      reject(error);
    };
    connection.setEncoding("utf8");
    connection.on("data", (/** @type {string} */ chunk) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        waiting.shift()?.resolve(line);
      }
    });
    connection.on("error", fail);
    connection.on("close", () => fail(new Error("the deck closed the connection")));
    connection.on("connect", () => {
      if (token) connection.write(`${JSON.stringify({ jsonrpc: "2.0", method: "deck/client", params: { token } })}\n`);
      resolve({
        ask: (line) =>
          new Promise((answered, failed) => {
            waiting.push({ resolve: answered, reject: failed });
            connection.write(`${line}\n`);
          }),
        close: () => connection.destroy(),
      });
    });
  });
}

/** Whole or not at all: a reader that sees the file sees the answer.
 * @param {string} file @param {string} text */
function writeWhole(file, text) {
  writeFileSync(`${file}.part`, text);
  renameSync(`${file}.part`, file);
}

// A daemon the agent started: in a session of its own, its parent the agent.
// It asks on one connection while the agent runs, then again on the same one
// once the agent is gone. The agent names itself: by the time this process
// runs, it may be gone already.
const lingering = valueOf("--linger");
if (lingering !== undefined) {
  const [answerTo = "", agent = ""] = args.slice(args.indexOf("--linger") + 2);
  const failed = (/** @type {unknown} */ error) => JSON.stringify({ failed: String(error) });
  try {
    const deck = await openDeck(lingering, bridge?.token);
    writeWhole(`${answerTo}.held`, await deck.ask(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).catch(failed));
    const until = Date.now() + 30_000;
    while (String(process.ppid) === agent && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
    writeWhole(answerTo, await deck.ask(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })).catch(failed));
  } catch (error) {
    writeWhole(`${answerTo}.held`, failed(error));
    writeWhole(answerTo, failed(error));
  }
  process.exit(0);
}

/** One POST to the deck's door — its unix socket, which Node's `fetch`
 * cannot reach and its HTTP can — resolving to the answer's status.
 * @param {string} socket @param {string} body @returns {Promise<number>} */
function postTo(socket, body) {
  return new Promise((resolve, reject) => {
    const asked = request("http://keepdeck/envelope", { socketPath: socket, method: "POST" }, (answer) => {
      answer.resume();
      answer.on("end", () => resolve(answer.statusCode ?? 0));
    });
    asked.on("error", reject);
    asked.end(body);
  });
}

/** Send one envelope through the bridge the plan armed, as a hook does: by
 * the pane's token, from this process, naming `reporter` as the process
 * that reports — this one's, unless told.
 * @param {{ type: string, paneId?: string, token?: string, payload?: object, cue?: string }} envelope
 * @param {string} reporter */
async function post({ type, paneId, token, payload, cue = "start" }, reporter = String(process.pid)) {
  if (!bridge) return print("stub: no bridge");
  const sent = {
    v: 3,
    type,
    paneId: paneId ?? bridge.pane,
    token: token ?? bridge.token,
    payload: { agent: "stub", reporter, ...payload },
  };
  const status = await postTo(bridge.socket, JSON.stringify(sent));
  print(`stub: posted ${type} ${status} ${cue}`);
}

// A hook's shell: a session of its own, its parent the agent. Its child is
// the hook, as a shell runs a hook's command.
const hookShell = valueOf("--hook");
if (hookShell !== undefined) {
  const [agent = ""] = args.slice(args.indexOf("--hook") + 2);
  const hook = spawn(process.execPath, [process.argv[1], "--send", hookShell, agent], { stdio: "inherit" });
  const code = await new Promise((resolve) => hook.on("exit", resolve));
  process.exit(typeof code === "number" ? code : 1);
}
const hookSends = valueOf("--send");
if (hookSends !== undefined) {
  // The hook: it names its agent as the process reporting, as a hook names
  // its agent's group — or itself, as a daemon's worker names its own.
  const [envelope = "{}", agent = ""] = [hookSends, args[args.indexOf("--send") + 2]];
  const said = JSON.parse(envelope);
  const reporter = said.payload?.reporter === "self" ? String(process.pid) : agent;
  const { reporter: _named, ...payload } = said.payload ?? {};
  await post({ ...said, payload }, reporter).catch((error) => print(`stub: post failed: ${String(error)}`));
  process.exit(0);
}

const child = flag("--child");
const resumed = valueOf("--resume");
const forked = valueOf("--fork");
const asked = resumed ?? forked;
if (asked !== undefined && flag("--reject")) {
  print(`stub: no conversation ${asked}`);
  process.exit(1);
}
const sessionId = resumed ?? randomUUID();
if (!child) print(forked === undefined ? `stub: ready ${sessionId}` : `stub: ready ${sessionId}, forked from ${forked}`);

// The conversation's own file: a resume continues the one it was in.
const store = valueOf("--store");
const transcript = store !== undefined && !child ? join(store, `${sessionId}.jsonl`) : undefined;
if (transcript !== undefined && store !== undefined) {
  mkdirSync(store, { recursive: true });
  appendFileSync(transcript, "");
}

const live = process.env.KEEPDECK_STUB_LIVE;
if (live && !child) {
  const held = join(live, sessionId);
  mkdirSync(live, { recursive: true });
  writeFileSync(held, String(process.pid));
  process.on("exit", () => rmSync(held, { force: true }));
}

/** @type {import("node:stream").Writable | undefined} */
let helper;

/** @param {string} cue */
function toHelper(cue) {
  helper ??= spawn(process.execPath, [process.argv[1], "--child"], { stdio: ["pipe", "inherit", "inherit"] }).stdin;
  helper.write(`${cue}\n`);
}

process.on("SIGTERM", () => (flag("--deaf") ? print("stub: not stopping") : process.exit(143)));

const cues = createInterface({ input: process.stdin });
cues.on("line", (line) => {
  const [cue = "", ...words] = line.trim().split(/\s+/);
  const rest = words.join(" ");
  if (cue === "exit") process.exit(Number(words[0] ?? 0));
  if (cue === "say") print(rest);
  if (cue === "fill") print(String(words[1] ?? "x").repeat(Number(words[0] ?? 0)));
  if (cue === "post") {
    void Promise.resolve()
      .then(() => post(JSON.parse(rest)))
      .catch((error) => print(`stub: post failed: ${String(error)}`));
  }
  if (cue === "child") toHelper(rest);
  if (cue === "hook") {
    const shell = [process.argv[1], "--hook", rest, String(process.pid)];
    spawn(process.execPath, shell, { detached: true, stdio: ["ignore", "inherit", "inherit"] }).unref();
  }
  if (cue === "mcp") {
    const [socket = "", ...line] = words;
    void openDeck(socket, bridge?.token)
      .then(async (deck) => {
        const answer = await deck.ask(line.join(" ")).finally(() => deck.close());
        print(`stub: mcp ${answer}`);
      })
      .catch((error) => print(`stub: mcp failed: ${String(error)}`));
  }
  if (cue === "linger") {
    const [socket = "", answerTo = ""] = words;
    const daemon = [process.argv[1], "--linger", socket, answerTo, String(process.pid)];
    spawn(process.execPath, daemon, { detached: true, stdio: "ignore" }).unref();
    print("stub: lingering");
  }
  if (cue === "record" && transcript !== undefined) {
    appendFileSync(transcript, `${rest}\n`);
    print(`stub: recorded ${String(JSON.parse(rest).type)}`);
  }
});
// The agent's own process ends it: its cues stop, and so does it.
if (child) cues.on("close", () => process.exit(0));

if (!child && !flag("--unbound")) {
  // A CLI's session hooks: the conversation bound, then the agent at its
  // prompt with nothing running — or waiting on a permission.
  const coming = flag("--waiting") ? { event: "waiting", reason: "permission" } : { event: "ready" };
  await post({ type: "session.bound", payload: { sessionId, ...(transcript !== undefined && { transcriptPath: transcript }) } })
    .then(() => post({ type: "agent.status", payload: coming }))
    .catch((error) => print(`stub: report failed: ${String(error)}`));
}
// A CLI waits for its person: so does this, until a cue or a stop ends it.
setInterval(() => {}, 1 << 30);
