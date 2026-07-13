import type { Disposable } from "./disposable.ts";

/**
 * The command system — the deck's single "do something" currency. Core
 * features and plugins REGISTER commands; every front-end (voice, MCP,
 * hotkeys, a future palette) INVOKES them by id through the same executor,
 * which validates arguments and journals every attempt.
 *
 * A plugin registers under its own namespace: the manifest declares each
 * command as a contribution (`contributes.commands`, plain entry ids), and
 * the full registry id becomes `<pluginId>.<entryId>` — derived by the host,
 * so a plugin cannot register into someone else's namespace. EXECUTING other
 * namespaces' commands (e.g. the core `agent.*` set) needs a `commands`
 * capability whose patterns cover them; a plugin's own commands are always
 * executable by it.
 */
export type CommandArgType = "string" | "boolean" | "number";

/** One declared argument — flat primitives only, exactly what the registry
 * validates a call against and what an external tool schema is built from. */
export interface CommandArgSpec {
  name: string;
  type: CommandArgType;
  required?: boolean;
  description: string;
}

export type CommandArgs = Record<string, string | boolean | number>;

/** A command as invokers see it — no handler crosses the contract. */
export interface CommandInfo {
  id: string;
  title: string;
  args: CommandArgSpec[];
  destructive: boolean;
}

export interface CommandError {
  code: "unknown-command" | "invalid-args" | "not-permitted" | "failed";
  message: string;
}

export type CommandResult =
  | { ok: true; value: unknown }
  | { ok: false; error: CommandError };

/** What a plugin registers. `id` is the manifest-declared ENTRY id (no
 * dots); the host prefixes the plugin id to form the registry id. */
export interface PluginCommandSpec {
  id: string;
  title: string;
  args: CommandArgSpec[];
  /** Hard to undo (close, delete) — invokers decide what to do with it. */
  destructive?: boolean;
  /** The effect. Return value must be serializable; throwing reports
   * `failed` with the message. */
  run(args: CommandArgs): Promise<unknown> | unknown;
}

export interface PluginCommands {
  /** Register a declared command under the plugin's namespace. */
  register(spec: PluginCommandSpec): Disposable;
  /** Execute a command by FULL registry id (e.g. `agent.spawn`,
   * `keepdeck.run.launch`). Never throws — refusals and failures come back
   * as a `CommandResult` error, uniform across transports. */
  execute(id: string, args: CommandArgs): Promise<CommandResult>;
  /** Every registered command, for pickers and prompt-building. */
  list(): Promise<CommandInfo[]>;
}
