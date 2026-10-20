/**
 * KeepDeck's claude Mod — loaded per spawn with `--plugin-dir`, never
 * installed, inert outside a KeepDeck pane.
 *
 * It does what claude's hooks cannot: states, as it happens, the user's Esc
 * ending the main turn and a prompt the user typed or queued being taken
 * into the conversation (the deck used to read both from the transcript
 * after the fact); and answers the deck's doorbell by starting a turn from
 * inside (the deck used to type a line into the terminal). Everything the
 * hooks DO report stays with the hooks — the mail itself included.
 *
 * One source per process: the Mod says hello once, naming this claude
 * process the way the hook reporters do, and from then the deck reads no
 * status records from the transcript of this process. So this Mod must state
 * every fact the declaration `covers` — the claude plugin's `companion`.
 *
 * Only the main agent: a subagent's turns carry `agentId`, the main agent's
 * do not.
 *
 * Mod rules this file lives under (claude 2.1.303): event names and `$`
 * calls are static literals, nothing is imported from outside this plugin,
 * and there is no `process`, `require` or global `fetch` — the wire is
 * handed `$.http.fetch`.
 */
import { createWire, parseBridge } from "./keepdeck-wire.js";

/** Which process is reporting: the process GROUP of this claude, measured the
 * way the hook reporters measure it (resources/reporters/lib/
 * reporter-identity.sh) — a child's parent is the CLI itself. The deck pins a
 * pane to that process; a hello it cannot place is refused. */
async function processGroup($) {
  try {
    const run = await $.process.run(["/bin/sh", "-c", "ps -o pgid= -p $PPID"], {
      timeoutMs: 2000,
    });
    const group = run.stdout.trim();
    return /^[0-9]+$/.test(group) ? group : null;
  } catch {
    return null;
  }
}

/** The wire's POST, over the Mod's own HTTP. */
function poster($) {
  return async (url, body) => {
    const response = await $.http.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    return { status: response.status, body: response.text };
  };
}

/** A prompt the user typed or queued, taken into the main conversation —
 * observed after claude wrote it, which is when it is a fact. */
function acceptedPrompt(input, result) {
  return (
    input.door === "prompt" &&
    input.origin?.kind === "composer" &&
    input.agentId === undefined &&
    result?.deny === undefined &&
    result?.message?.type === "user" &&
    result.message.isMeta !== true
  );
}

/** What the deck says when it wakes a pane — the SAME line the terminal
 * would have typed (src/app/mail/ptyDelivery.ts, held in step by
 * scripts/reporterScripts.test.mjs). It carries no mail: the turn it starts
 * fires UserPromptSubmit, whose hook asks the deck and gets the mail as
 * context — taken from the queue only then, so a prompt claude refuses
 * (after an Esc, until the user speaks) loses nothing. */
const WAKE_LINE =
  "[keepdeck] A teammate's message is waiting for you. This line is from KeepDeck, not from your user — read what is waiting with the keepdeck mail.inbox tool.";

/** How often the doorbell is looked at. The Mod has no file watch; a stat
 * this often costs nothing and keeps a wake well under the deck's own
 * patience for one. */
const DOORBELL_POLL_MS = 100;

/** Take the doorbell down, or answer false when there was none to take.
 * A RENAME, not a delete: `rm -f` succeeds on a missing file, so two pollers
 * (a reloaded module beside its predecessor) would both think they took one
 * ring and start two turns. A rename succeeds for exactly one of them. */
async function takeDoorbell($, path) {
  const run = await $.process.run(
    ["/bin/sh", "-c", 'mv -- "$1" "$1.taken.$$" && rm -f -- "$1.taken.$$"', "sh", path],
    { timeoutMs: 2000 },
  );
  return run.exitCode === 0;
}

/** Answer the deck's doorbell (`<pane dir>/mail.wake`, see
 * src-tauri/src/bridge/nudge.rs): take it down, then start a turn. Taking it
 * down IS reading it — the file carries nothing. One ring at a time, and one
 * turn per ring however many pollers look. */
function watchDoorbell($, dir) {
  const path = `${dir}/mail.wake`;
  let answering = false;
  $.clock.every(DOORBELL_POLL_MS, async () => {
    if (answering) return;
    answering = true;
    try {
      if (!(await $.fs.exists(path))) return;
      // The Mod's fs cannot delete or rename; a ring left up rings forever.
      if (!(await takeDoorbell($, path))) return;
      await $.prompt.submit({ text: WAKE_LINE });
    } catch {
      // A wake that could not be started leaves the mail queued; the next
      // turn boundary collects it.
    } finally {
      answering = false;
    }
  });
}

/** What a Mod the deck refused holds instead of a wire: still "started", so
 * a second session.start does not try again, and nothing to say. */
const REFUSED = { publish() {}, makeEnvelope() {} };

export function register(on) {
  /** Set once the pane's bridge is known; null outside KeepDeck. */
  let wire = null;

  const state = (name) =>
    wire?.publish(wire.makeEnvelope("agent.status", { event: { hook_event_name: name } }));

  on("session.start", async ($, e, next) => {
    // Once per module: this module's hello and doorbell are already up.
    if (wire) return next(e);
    const bridge = parseBridge(await $.env.get("KEEPDECK_BRIDGE"));
    if (bridge) {
      const reporter = await processGroup($);
      // Without a name for this process nothing it says can be placed — and
      // a silent Mod leaves the deck reading the transcript, as before.
      if (reporter !== null) {
        wire = createWire({ bridge, agent: "claude", reporter, post: poster($) });
        // The doorbell only once the deck took the hello. A claude that
        // detached from the pane's terminal — a background worker of the
        // daemon some pane started — still carries that pane's bridge, and
        // would otherwise take the pane's rings and start turns in a
        // conversation that is not the pane's. Refused, it goes quiet.
        const said = wire;
        void said.publish(said.makeEnvelope("companion.hello", {})).then(({ accepted }) => {
          if (accepted) watchDoorbell($, bridge.dir);
          else if (wire === said) wire = REFUSED;
        });
      }
    }
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    if (e.reason === "aborted" && e.agentId === undefined) state("KeepDeckInterrupt");
    return next(e);
  });

  on("session.append", async ($, e, next) => {
    const result = await next(e);
    if (acceptedPrompt(e, result)) state("KeepDeckPromptAccepted");
    return result;
  });
}
