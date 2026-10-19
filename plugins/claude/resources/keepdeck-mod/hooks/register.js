/**
 * KeepDeck's claude Mod — loaded per spawn with `--plugin-dir`, never
 * installed, inert outside a KeepDeck pane.
 *
 * It states what claude's hooks cannot, as it happens: the user's Esc ending
 * the main turn, and a prompt the user typed or queued being taken into the
 * conversation. The deck used to learn both by reading the transcript after
 * the fact. Everything the hooks DO report stays with the hooks.
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

export function register(on) {
  /** Set once the pane's bridge is known; null outside KeepDeck. */
  let wire = null;

  const state = (name) =>
    wire?.publish(wire.makeEnvelope("agent.status", { event: { hook_event_name: name } }));

  on("session.start", async ($, e, next) => {
    const bridge = parseBridge(await $.env.get("KEEPDECK_BRIDGE"));
    if (bridge) {
      const reporter = await processGroup($);
      // Without a name for this process nothing it says can be placed — and
      // a silent Mod leaves the deck reading the transcript, as before.
      if (reporter !== null) {
        wire = createWire({ bridge, agent: "claude", reporter, post: poster($) });
        wire.publish(wire.makeEnvelope("companion.hello", {}));
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
