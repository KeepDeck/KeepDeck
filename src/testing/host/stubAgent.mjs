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
//   --child        a process the agent started in its own terminal: it
//                  reports nothing of its own and takes its cues from the
//                  agent
//   --store <dir>  keep the conversation's file there, `<id>.jsonl`, as a
//                  CLI keeps its transcript, and name it in its binding
//   --linger <socket> <file> <agent pid>
//                  the daemon a `linger` cue starts: nothing else
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
//   record <json>  write one record to the conversation's file, as a CLI
//                  writes a line of its transcript; then print
//                  `stub: recorded <type>`
//   mcp <socket> <line>
//                  ask the deck's MCP socket one JSON-RPC line, greeting it
//                  with the pane's secret as an injected shim does; then
//                  print `stub: mcp <the one line that answers it>`
//   linger <socket> <file>
//                  start a process that leaves this terminal's session, as
//                  a daemon an agent starts does, and outlives the pane: once
//                  this agent is gone it asks the socket `initialize` with the
//                  pane's secret and writes the answer to <file>; print
//                  `stub: lingering`
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

/** One line asked of the deck's MCP socket, greeted with `token`: the one
 * line that answers it.
 * @param {string} socket @param {string | undefined} token @param {string} line
 * @returns {Promise<string>} */
function askDeck(socket, token, line) {
  return new Promise((resolve, reject) => {
    const connection = connect(socket);
    let buffer = "";
    connection.setEncoding("utf8");
    connection.on("connect", () => {
      if (token) connection.write(`${JSON.stringify({ jsonrpc: "2.0", method: "deck/client", params: { token } })}\n`);
      connection.write(`${line}\n`);
    });
    connection.on("data", (/** @type {string} */ chunk) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      connection.destroy();
      resolve(buffer.slice(0, end));
    });
    connection.on("error", reject);
    connection.on("close", () => reject(new Error("the deck closed the connection")));
  });
}

// A daemon the agent started: in a session of its own, its parent the agent.
// It waits for the agent to go, then asks as the pane it came from.
// The agent names itself: by the time this process runs, it may be gone.
const lingering = valueOf("--linger");
if (lingering !== undefined) {
  const [answerTo = "", agent = ""] = args.slice(args.indexOf("--linger") + 2);
  const until = Date.now() + 30_000;
  while (String(process.ppid) === agent && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
  const asked = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const answer = await askDeck(lingering, bridge?.token, asked).catch((error) => JSON.stringify({ failed: String(error) }));
  // Whole or not at all: a reader that sees the file sees the answer.
  writeFileSync(`${answerTo}.part`, answer);
  renameSync(`${answerTo}.part`, answerTo);
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

/** Send one envelope through the bridge the plan armed, as a hook does: by
 * the pane's token, from this process.
 * @param {{ type: string, paneId?: string, token?: string, payload?: object, cue?: string }} envelope */
async function post({ type, paneId, token, payload, cue = "start" }) {
  if (!bridge) return print("stub: no bridge");
  const sent = {
    v: 2,
    type,
    paneId: paneId ?? bridge.pane,
    token: token ?? bridge.token,
    payload: { agent: "stub", reporter: String(process.pid), ...payload },
  };
  const answer = await fetch(bridge.url, { method: "POST", body: JSON.stringify(sent) });
  print(`stub: posted ${type} ${answer.status} ${cue}`);
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
  if (cue === "mcp") {
    const [socket = "", ...line] = words;
    void askDeck(socket, bridge?.token, line.join(" "))
      .then((answer) => print(`stub: mcp ${answer}`))
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
  // prompt with nothing running.
  await post({ type: "session.bound", payload: { sessionId, ...(transcript !== undefined && { transcriptPath: transcript }) } })
    .then(() => post({ type: "agent.status", payload: { event: "ready" } }))
    .catch((error) => print(`stub: report failed: ${String(error)}`));
}
// A CLI waits for its person: so does this, until a cue or a stop ends it.
setInterval(() => {}, 1 << 30);
