/**
 * The OpenCode CLI plugin: identity, detection, and the spawn/resume hooks.
 * opencode creates its session id lazily — KeepDeck's own plugin
 * (injected per spawn via `OPENCODE_CONFIG_CONTENT`, which MERGES into the
 * user's config; nothing is installed on their side) reports it back
 * through the bridge, catching `/new` typed inside the TUI too.
 */
import { launchPlans, type KeepDeckPlugin } from "@keepdeck/plugin-api";
import { icon } from "./icon";
import { opencodeHistory } from "./history";
import { relocatingForkId } from "./fork";
import { launchFor, stageLaunch } from "./launch";
import { OPENCODE_MAIL_CHANNELS, renderOpencodeMail } from "./mail";
import { attributeOpencodeEvent, normalizeOpencodeStatus } from "./status";
import { normalizeOpencodeUsage } from "./usage";

const plugin: KeepDeckPlugin = {
  activate(ctx) {
    ctx.agents.register({
      id: "opencode",
      label: "OpenCode",
      icon,
      detect: { bin: "opencode" },
      // opencode has a native client/server split: the host can run this pane
      // as a local `opencode attach <ep>` thin client against an `opencode
      // serve` on a VPS. Support and http/https schemes are declared once in
      // the manifest; the hooks only implement the behavior.
      history: opencodeHistory(ctx),
      // Pane usage from the injected reporter's `message.updated` envelopes.
      // No account windows — opencode exposes none (see [`normalizeOpencodeUsage`]).
      usage: {
        normalize: normalizeOpencodeUsage,
      },
      // Turn lifecycle from the same reporter's bus subscription — which is
      // why this agent needs no transcript recovery: an interrupt is stated
      // on the bus like everything else. It is stated as an ERROR, though,
      // named `MessageAbortedError` and published before the idle behind it,
      // so what tells an interrupted turn from a broken one is the name and
      // not the shape (see [`normalizeOpencodeStatus`]).
      //
      // The other two edges no other agent gives us: permission.replied
      // resolves an approval, and question.asked is the only word anywhere
      // for a turn standing on a choice put in front of the user.
      //
      // Mail is the courier's half: it asks, and what it gets back it puts
      // straight into the session — with a turn for somebody's words,
      // without one for standing context. Which is also why this pane is
      // never woken by typing at it: `wake: "bridge"` sends the deck's nudge
      // to the courier, which is already inside the process and can start a
      // turn properly. Declared statically, so an install missing
      // mail-courier.js leaves mail to expire rather than fall back to the
      // terminal — a broken install should look broken, not different.
      status: {
        normalize: normalizeOpencodeStatus,
        attribute: attributeOpencodeEvent,
        mail: { channels: OPENCODE_MAIL_CHANNELS, render: renderOpencodeMail },
        wake: "bridge",
      },
      hooks: launchPlans({
        stage: (input, output) => stageLaunch(ctx, input, output),
        resume: (input) => launchFor(ctx, input).resume(input.sessionId),
        // Native `-s <id> --fork` re-homes the fork to the SOURCE session's
        // directory, ignoring the target (probe-verified, 1.18.4). So a
        // RELOCATING fork goes through export→rekey→import (see `fork.ts`),
        // binding the new session's directory to the target. `relocatingForkId`
        // returns the relocated session's id, or null (native `--fork`
        // fallback) for a not-yet-provisioned worktree OR any recipe failure.
        // Remote never gets here: `stage` attached to the server, where the
        // fork runs server-side.
        fork: async (input) => {
          const relocated = await relocatingForkId(ctx, input);
          return relocated ? ["-s", relocated] : ["-s", input.sessionId, "--fork"];
        },
      }),
    });
  },
};

export default plugin;
