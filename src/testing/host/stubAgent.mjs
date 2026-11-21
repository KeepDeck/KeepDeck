// The stub agent: the program a pane runs in the page's tests on the host,
// standing in for an agent's CLI — which needs a network and an account. It
// does what the page depends on a CLI for, through the channels a CLI uses:
// it prints into its terminal, binds its conversation through the deck's
// bridge as a session hook does, and ends on a cue typed into its terminal or
// on a stop. Kept to that: every behaviour here is one the page reads.
//
// Arguments, from the stub plugin's plans:
//   --resume <id>  continue conversation <id>
//   --fork <id>    open a new conversation copied from <id>
//   --reject       refuse the resume or the fork: exit at once, having
//                  reported nothing
//   --deaf         ignore a polite stop (TERM), so only the kill ends it
//
// With KEEPDECK_STUB_LIVE set — a process run outside the deck's panes —
// it keeps a file named for its conversation in that folder while it runs:
// the stub plugin's registry of live sessions reads them, as a CLI's own
// registry knows its interactive runs.
//
// Cues, one per line typed into its terminal:
//   exit <code>    end with that code
//   say <text>     print the text
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

const resumed = valueOf("--resume");
const forked = valueOf("--fork");
const asked = resumed ?? forked;
if (asked !== undefined && flag("--reject")) {
  print(`stub: no conversation ${asked}`);
  process.exit(1);
}
const sessionId = resumed ?? randomUUID();
print(forked === undefined ? `stub: ready ${sessionId}` : `stub: ready ${sessionId}, forked from ${forked}`);

const live = process.env.KEEPDECK_STUB_LIVE;
if (live) {
  const held = join(live, sessionId);
  mkdirSync(live, { recursive: true });
  writeFileSync(held, String(process.pid));
  process.on("exit", () => rmSync(held, { force: true }));
}

/** Bind the conversation through the bridge the plan armed, as a session
 * hook does: by the pane's token, from a process of the pane's terminal. */
async function bind() {
  const armed = process.env.KEEPDECK_BRIDGE;
  if (!armed) return print("stub: no bridge");
  const bridge = JSON.parse(armed);
  const envelope = {
    v: 2,
    type: "session.bound",
    paneId: bridge.pane,
    token: bridge.token,
    payload: { agent: "stub", sessionId, reporter: String(process.pid) },
  };
  const answer = await fetch(bridge.url, { method: "POST", body: JSON.stringify(envelope) });
  print(`stub: bound ${answer.status}`);
}

process.on("SIGTERM", () => (flag("--deaf") ? print("stub: not stopping") : process.exit(143)));

createInterface({ input: process.stdin }).on("line", (line) => {
  const [cue = "", ...rest] = line.trim().split(/\s+/);
  if (cue === "exit") process.exit(Number(rest[0] ?? 0));
  if (cue === "say") print(rest.join(" "));
});

await bind().catch((error) => print(`stub: bind failed: ${String(error)}`));
// A CLI waits for its person: so does this, until a cue or a stop ends it.
setInterval(() => {}, 1 << 30);
