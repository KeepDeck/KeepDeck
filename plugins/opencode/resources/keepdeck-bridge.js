/**
 * What both of KeepDeck's opencode plugins need to talk to the deck.
 *
 * They stay two plugins — the reporter states facts about the pane and asks
 * nothing, the courier carries mail in and is the only one that asks — but
 * they run in the same process and speak the same wire, and that wire was
 * written out twice. Three of the four decisions here are silent-failure
 * shaped: change the reporter identity rule or the envelope filename in one
 * file and the deck ignores that plugin's postbacks with nothing logged on
 * either side.
 *
 * Shipped beside them and imported as a sibling: `build-plugins.mjs` copies
 * `resources/` whole, and opencode loads each plugin by absolute path, so a
 * relative import between them resolves the same way in the repo and in the
 * bundle.
 */
import { randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Which process is reporting, on every lane either plugin publishes.
 *
 * The deck pins a pane's identity to ONE reporting process and refuses the
 * others — the bridge secret is inherited by the pane's whole process tree,
 * so it cannot tell them apart on its own. These run INSIDE the agent, so
 * the agent's own pid is that name, and being two plugins in the SAME
 * process they answer identically. A nested opencode gets its own and is
 * refused. The shell reporters answer the same question with the process
 * group of the hook's parent, since a hook is not the agent.
 */
export const REPORTER = String(process.pid);

/**
 * This pane's bridge, or null when nothing spawned us from KeepDeck.
 *
 * `dir` is the pane's OWN inbox — one directory per pane, so an answer is
 * addressed by pane and a correlation naming somebody else's reaches nobody.
 */
export function readBridge() {
  let bridge;
  try {
    bridge = JSON.parse(process.env.KEEPDECK_BRIDGE ?? "");
  } catch {
    return null;
  }
  const { dir, pane, token } = bridge ?? {};
  return dir && pane && token ? { dir, pane, token } : null;
}

/**
 * Atomically drop one envelope into the inbox: uniquely named (so parallel
 * events never collide), written as `.tmp` and renamed, so the deck's
 * watcher never reads a torn file. Answers whether it landed.
 *
 * Best-effort like everything on this path — a full disk must not break the
 * user's session.
 */
export function publish(dir, envelope) {
  try {
    const base = join(dir, `${envelope.type}-${randomUUID()}`);
    writeFileSync(`${base}.tmp`, JSON.stringify(envelope));
    renameSync(`${base}.tmp`, `${base}.json`);
    return true;
  } catch {
    return false;
  }
}
