import type { ArgSpec, CommandArgs } from "./args";
import { validateArgs } from "./args";
import { isValidCommandId } from "./ids";

/**
 * The command registry — the deck's single point of command execution.
 * Everything an actor can DO to the deck is a registered command; core
 * features and plugins contribute them, and every front-end (hotkeys, voice,
 * MCP, a future palette) is just an invoker calling `execute` by id. One
 * executor means one place for validation, permission checks at the
 * transport, and the journal.
 *
 * Registration is EXPLICIT (composition root for core, `activate` for
 * plugins) — a duplicate id is a programmer error and throws, matching how
 * the other register* surfaces behave.
 */
export interface CommandSpec {
  id: string;
  /** Human-readable name, shown in journals/pickers and to external clients. */
  title: string;
  args: ArgSpec[];
  /** Marks a command whose effect is hard to undo (close, delete). Invokers
   * decide what to do with it (confirm, badge); the registry only records it. */
  destructive?: boolean;
  /** The effect. `source` is who invoked it (host / a plugin / an external
   * client) — a handler that scopes to the caller reads it (e.g. `settings.open`
   * lands on the calling plugin's own section); most ignore it. A returned
   * value must be serializable — it crosses plugin RPC and external
   * transports verbatim. Throwing reports `failed`. */
  run(args: CommandArgs, source: CommandSource): Promise<unknown> | unknown;
}

/** A command as invokers see it — the spec minus its handler. */
export interface CommandInfo {
  id: string;
  title: string;
  args: ArgSpec[];
  destructive: boolean;
}

/** Who asked. Journaled with every call — the voice history reads it, and
 * an audit trail needs it verbatim. */
export type CommandSource =
  | { kind: "host" }
  | { kind: "plugin"; pluginId: string }
  | { kind: "external"; client: string };

export type CommandError =
  | { code: "unknown-command"; message: string }
  | { code: "invalid-args"; message: string }
  | { code: "failed"; message: string };

export type CommandResult =
  | { ok: true; value: unknown }
  | { ok: false; error: CommandError };

export interface JournalEntry {
  seq: number;
  at: number;
  source: CommandSource;
  commandId: string;
  args: CommandArgs;
  outcome: "ok" | "error";
  error?: CommandError;
}

export interface CommandRegistry {
  /** Add a command. Returns its unregister. Throws on an invalid or
   * duplicate id — both are wiring bugs, not runtime conditions. */
  register(spec: CommandSpec): () => void;
  has(id: string): boolean;
  list(): CommandInfo[];
  execute(
    id: string,
    args: CommandArgs,
    source: CommandSource,
  ): Promise<CommandResult>;
  /** Newest-last view of recent calls, rejections included — an attempt that
   * failed validation is exactly what an audit wants to see. */
  journal(): readonly JournalEntry[];
  /** Fires after every execute with its journal entry. */
  onDidExecute(cb: (entry: JournalEntry) => void): () => void;
}

const JOURNAL_CAP = 200;

export function createCommandRegistry(
  opts: { now?: () => number; journalCap?: number } = {},
): CommandRegistry {
  const now = opts.now ?? Date.now;
  const cap = opts.journalCap ?? JOURNAL_CAP;
  const commands = new Map<string, CommandSpec>();
  const journal: JournalEntry[] = [];
  const listeners = new Set<(entry: JournalEntry) => void>();
  let seq = 0;

  function record(
    source: CommandSource,
    commandId: string,
    args: CommandArgs,
    error?: CommandError,
  ): void {
    const entry: JournalEntry = {
      seq: ++seq,
      at: now(),
      source,
      commandId,
      args,
      outcome: error ? "error" : "ok",
      ...(error ? { error } : {}),
    };
    journal.push(entry);
    if (journal.length > cap) journal.splice(0, journal.length - cap);
    for (const cb of [...listeners]) cb(entry);
  }

  return {
    register(spec) {
      if (!isValidCommandId(spec.id))
        throw new Error(`invalid command id "${spec.id}"`);
      if (commands.has(spec.id))
        throw new Error(`command "${spec.id}" is already registered`);
      commands.set(spec.id, spec);
      return () => {
        // Only the surviving registration may unregister; a disposed early
        // copy must not tear down a later legitimate one.
        if (commands.get(spec.id) === spec) commands.delete(spec.id);
      };
    },

    has: (id) => commands.has(id),

    list: () =>
      [...commands.values()].map((s) => ({
        id: s.id,
        title: s.title,
        args: s.args,
        destructive: s.destructive ?? false,
      })),

    async execute(id, args, source) {
      const spec = commands.get(id);
      if (!spec) {
        const error: CommandError = {
          code: "unknown-command",
          message: `no command "${id}"`,
        };
        record(source, id, args, error);
        return { ok: false, error };
      }
      const problems = validateArgs(spec.args, args);
      if (problems.length > 0) {
        const error: CommandError = {
          code: "invalid-args",
          message: problems.join("; "),
        };
        record(source, id, args, error);
        return { ok: false, error };
      }
      try {
        const value = (await spec.run(args, source)) ?? null;
        record(source, id, args);
        return { ok: true, value };
      } catch (e) {
        const error: CommandError = {
          code: "failed",
          message: e instanceof Error ? e.message : String(e),
        };
        record(source, id, args, error);
        return { ok: false, error };
      }
    },

    journal: () => journal,

    onDidExecute(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
