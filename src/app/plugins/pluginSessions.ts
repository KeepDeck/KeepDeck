/**
 * A plugin's own PTY processes (`ctx.services.sessions`), as the host
 * launches them: under a lease the lifecycle grants the plugin in the
 * workspace it was started from — no pane, no folder of ours. The
 * workspace's close stops them; a handle's close stops that exact session.
 * The plugin API is unchanged: the plugin names neither the lease nor the
 * workspace.
 */
import type { PluginSessionEvent, PluginSessionHandle, PluginSpawnOptions } from "@keepdeck/plugin-api";
import type { LaunchOwner } from "../../ipc/generated/lifecycle/LaunchOwner";
import type { LeaseAsk } from "../../ipc/generated/lifecycle/LeaseAsk";
import type { PermitId } from "../../ipc/generated/lifecycle/PermitId";
import type { Reply } from "../../ipc/generated/lifecycle/Reply";
import type { Session, SessionEvent, SpawnOptions } from "../../ipc/session";
import { noAnswerText, refusalText } from "../../presentation/lifecycleWords";

export interface PluginSessionsDeps {
  lease(ask: LeaseAsk): Promise<Reply>;
  /** The workspace a plugin's process now belongs to — the one on screen —
   * or null with none open. */
  workspace(): string | null;
  open(opts: SpawnOptions, permit: PermitId, owner: LaunchOwner, onEvent: (event: SessionEvent) => void): Promise<Session>;
}

export interface PluginSessionsBackend {
  spawn(pluginId: string, opts: PluginSpawnOptions, onEvent: (event: PluginSessionEvent) => void): Promise<PluginSessionHandle>;
}

/** The launch a plugin's own process is leased as: the plugin's, in the
 * workspace it is started from, in the folder it starts in — the one the
 * spawn door admits it into, and the machine holds while it runs — or in
 * none. */
export function pluginLaunch(pluginId: string, workspace: string, cwd: string | null): Extract<LeaseAsk, { kind: "launch" }> {
  return { kind: "launch", workspace, owner: { kind: "plugin", plugin: pluginId, workspace }, dir: cwd };
}

export function createPluginSessions(deps: PluginSessionsDeps): PluginSessionsBackend {
  return {
    async spawn(pluginId, opts, onEvent) {
      const workspace = deps.workspace();
      if (workspace === null) throw new Error("no workspace is open to run a plugin's process in");
      // One folder for the lease and the spawn: the door admits the process
      // only into the folder its lease names.
      const cwd = opts.cwd ?? null;
      const ask = pluginLaunch(pluginId, workspace, cwd);
      const owner = ask.owner;
      const reply = await deps.lease(ask);
      if (reply.kind !== "answered") throw new Error(noAnswerText(reply));
      if (reply.answer.kind === "refused") throw new Error(refusalText(reply.answer.refusal));
      if (reply.answer.kind !== "leased") throw new Error(`the lifecycle answered a launch lease with "${reply.answer.kind}"`);
      const session = await deps.open(
        {
          command: opts.command ?? null,
          args: opts.args ?? [],
          env: opts.env ?? [],
          cwd,
          cols: opts.cols,
          rows: opts.rows,
        },
        reply.answer.permit,
        owner,
        (event) => onEvent(event.type === "output" ? { type: "output", bytes: event.bytes } : { type: "exit", code: event.code }),
      );
      return {
        id: String(session.id),
        write: session.write,
        resize: session.resize,
        close: () => session.stop().then(() => {}),
      };
    },
  };
}
