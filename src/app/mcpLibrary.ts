/**
 * The MCP-server library's owner: every read and every write, wherever it
 * comes from — the editor, an agent's command, the spawn path asking what a
 * workspace gets.
 *
 * The twin of `skillsLibrary.ts`, and the same shape for the same reason: a
 * library that existed only inside a React hook could not be reached by a
 * command, so the owner is a plain object the composition root builds once
 * and every door shares. It owns the RULES a write must pass (a valid name, a
 * body the codec can carry, a name no shipped server already holds) and the
 * NOTIFICATION that a write happened; the codec and the vocabulary are the
 * domain's, the bytes are the storage's.
 *
 * Nothing is staged: a server is data, and the spawn path reads the
 * effective set through [`McpLibrary.serversFor`] at plan time. A write
 * therefore reaches only NEW panes — the same standing limit skills have.
 */
import {
  MCP_SERVER_NAME_RULE,
  composeMcpServerFile,
  mcpServerBodyProblem,
  mcpServerNameProblem,
  parseMcpServerFile,
  sameMcpScope,
  type McpScope,
  type McpServerDraft,
  type McpServerVerdict,
} from "../domain/mcp";
import { log } from "../ipc/log";
import { injectableOf } from "./mcp/injectable";
import type { McpLibraryServer, McpServerSource } from "./mcp/injection";

/** One stored row, as the storage hands it up: a scope, a name, the file. */
export interface LibraryMcpServer {
  scope: McpScope;
  name: string;
  content: string;
}

/** The stored library itself. Injected so the owner can be driven without
 * IPC, and so the one adapter that knows the Rust command names stays below. */
export interface McpStorage {
  fetch(): Promise<LibraryMcpServer[]>;
  save(scope: McpScope, name: string, content: string, expectNew: boolean): Promise<void>;
  rename(scope: McpScope, from: string, to: string): Promise<void>;
  remove(scope: McpScope, name: string): Promise<void>;
  /** Drop a whole workspace scope. Idempotent on absence. */
  forgetWorkspace(wsId: string): Promise<void>;
}

export interface McpLibraryPorts {
  storage: McpStorage;
  /** Names the bundled tier holds. A library entry under one would be
   * dropped by the injection's first-claim rule in every CLI, so authoring
   * one is refused here, where the refusal can be worded. */
  reserved: readonly string[];
}

/** One row as a surface lists it: the stored file already judged, so a
 * malformed one shows up with its reason instead of vanishing. */
export interface McpLibraryRow {
  scope: McpScope;
  name: string;
  verdict: McpServerVerdict;
}

export interface McpLibrary extends McpServerSource {
  /** The stored servers — one scope's, or every scope's when none is named.
   * THROWS on a backend failure: an empty library and one that could not be
   * read must never arrive as the same value. */
  list(scope?: McpScope): Promise<McpLibraryRow[]>;
  /** One server as the editable draft. REFUSES a name the scope does not
   * hold, and a file the codec cannot read — with the reason, so the user
   * can repair the file by hand. */
  read(scope: McpScope, name: string): Promise<McpServerDraft>;
  /** Write a new server. Refused if the name is taken — by the STORAGE, the
   * one precondition this owner does not answer itself: the check has to
   * hold when the library could not be read at all. */
  create(scope: McpScope, draft: McpServerDraft): Promise<void>;
  /** Overwrite an existing server — refused if there is none by that name,
   * so an update can never turn into a create. */
  update(scope: McpScope, draft: McpServerDraft): Promise<void>;
  /** Rename by moving the file. Refused if `to` is taken, or reserved. */
  rename(scope: McpScope, from: string, to: string): Promise<void>;
  /** Remove a server. Refused if there is none by that name: the storage
   * calls a missing file a success, which would answer "done" to a caller
   * that named the wrong server. */
  remove(scope: McpScope, name: string): Promise<void>;
  /**
   * Forget a closing workspace's whole scope. Workspace ids are REUSED slots,
   * so a scope left behind would be inherited — servers, tokens and all — by
   * the next workspace to take the id. Not a refusal on absence: closing a
   * workspace that never had servers is the common case.
   */
  forgetWorkspace(wsId: string): Promise<void>;
  /** Be told when the library changed, whoever changed it. */
  subscribe(listener: () => void): () => void;
}

/** How a scope reads inside a refusal. Without the workspace id: no surface
 * shows one, and the caller already knows which workspace it asked about. */
const describeScope = (scope: McpScope): string =>
  scope.kind === "global" ? "the global library" : "this workspace's library";

export function createMcpLibrary(ports: McpLibraryPorts): McpLibrary {
  const listeners = new Set<() => void>();
  let notifying = false;

  /** THE scope filter — asked by every read, answered once here. */
  async function rows(scope?: McpScope): Promise<LibraryMcpServer[]> {
    const all = await ports.storage.fetch();
    return scope ? all.filter((row) => sameMcpScope(row.scope, scope)) : all;
  }

  /** One scope's library, read ONCE, answering the two questions every
   * mutation asks of it — both refusals have their single home here. */
  async function library(scope: McpScope) {
    const all = await rows(scope);
    return {
      existing(name: string): LibraryMcpServer {
        const stored = all.find((row) => row.name === name);
        if (!stored) throw new Error(`No server "${name}" in ${describeScope(scope)}`);
        return stored;
      },
      /** A COURTESY refusal, not the guard — the storage answers from the
       * disk, which is the check that survives a library we could not read. */
      requireFree(name: string): void {
        if (all.some((row) => row.name === name)) {
          throw new Error(`"${name}" is already taken in ${describeScope(scope)}`);
        }
      },
    };
  }

  /** Every mutation goes through here, so "a write changed the library" is
   * said once — and said for a FAILED write too: once a call has reached the
   * storage the library may have changed whatever it answers. */
  async function writeThenNotify(write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } finally {
      // Not re-entrant: a listener that writes would be notified by its own
      // write, and nothing would bound the chain.
      if (!notifying) {
        notifying = true;
        try {
          for (const listener of [...listeners]) {
            try {
              listener();
            } catch {
              // A view's refresh is not this write's problem.
            }
          }
        } finally {
          notifying = false;
        }
      }
    }
  }

  /** One home for the two rules a NAME must pass to be authored: the grammar
   * every client accepts, and the bundled tier's reservation. A create and
   * a rename both ask; an update does not — the name identifies a file the
   * caller found on disk, and one a hand edit made must still be editable. */
  function requireAuthorable(name: string): void {
    const problem = mcpServerNameProblem(name);
    if (problem === "empty") throw new Error("A server needs a name");
    if (problem === "invalid") {
      throw new Error(`"${name}" is not a valid server name — ${MCP_SERVER_NAME_RULE}`);
    }
    if (ports.reserved.includes(name)) {
      throw new Error(
        `"${name}" is a server KeepDeck ships with — every agent already has it; pick another name`,
      );
    }
  }

  /** The stored form of a draft someone authored here, refused before a
   * byte moves when the codec could not carry it. */
  function authoredFile(draft: McpServerDraft): string {
    switch (mcpServerBodyProblem(draft.body)) {
      case "empty-command":
        throw new Error("A local server needs a command to run");
      case "empty-url":
        throw new Error("A remote server needs a URL");
    }
    return composeMcpServerFile(draft.body);
  }

  /** The draft a stored row holds, or the refusal that it holds none. */
  function draftOf(row: LibraryMcpServer): McpServerDraft {
    const verdict = parseMcpServerFile(row.content);
    if (verdict.kind === "malformed") {
      throw new Error(
        `"${row.name}" cannot be edited here — ${verdict.reason}. Edit its file directly.`,
      );
    }
    return { name: row.name, body: verdict.body };
  }

  // Every method is `async` so a refusal reaches the caller the same way a
  // backend failure does — as a rejection.
  return {
    list: async (scope) =>
      (await rows(scope)).map((row) => ({
        scope: row.scope,
        name: row.name,
        verdict: parseMcpServerFile(row.content),
      })),

    read: async (scope, name) => draftOf((await library(scope)).existing(name)),

    create: async (scope, draft) => {
      requireAuthorable(draft.name);
      const content = authoredFile(draft);
      await writeThenNotify(() => ports.storage.save(scope, draft.name, content, true));
    },

    update: async (scope, draft) => {
      (await library(scope)).existing(draft.name);
      const content = authoredFile(draft);
      await writeThenNotify(() => ports.storage.save(scope, draft.name, content, false));
    },

    rename: async (scope, from, to) => {
      requireAuthorable(to);
      const scoped = await library(scope);
      scoped.existing(from);
      scoped.requireFree(to);
      await writeThenNotify(() => ports.storage.rename(scope, from, to));
    },

    remove: async (scope, name) => {
      (await library(scope)).existing(name);
      await writeThenNotify(() => ports.storage.remove(scope, name));
    },

    forgetWorkspace: (wsId) => writeThenNotify(() => ports.storage.forgetWorkspace(wsId)),

    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * The workspace's effective set: every global server, then the
     * workspace's own, a workspace entry replacing a global one of the same
     * name — the library's precedence rule, decided once here. A file the
     * codec cannot read is skipped with a warning rather than failing the
     * spawn: one broken server must not cost a pane the rest.
     */
    serversFor: async (workspaceId) => {
      const all = await rows();
      const scoped = (kind: McpScope) => all.filter((row) => sameMcpScope(row.scope, kind));
      const effective = new Map<string, LibraryMcpServer>();
      for (const row of scoped({ kind: "global" })) effective.set(row.name, row);
      for (const row of scoped({ kind: "workspace", wsId: workspaceId })) {
        effective.set(row.name, row);
      }
      const servers: McpLibraryServer[] = [];
      for (const row of effective.values()) {
        const verdict = parseMcpServerFile(row.content);
        if (verdict.kind === "malformed") {
          log.warn("web:mcp", `library server "${row.name}" not injected: ${verdict.reason}`);
          continue;
        }
        servers.push(injectableOf(row.name, verdict.body));
      }
      // Two servers naming one variable would leave the pane with whichever
      // value was written last — worth a line in the log, since the losing
      // server will simply fail to authenticate.
      const seen = new Map<string, string>();
      for (const { spec, env } of servers) {
        for (const [variable] of env) {
          const other = seen.get(variable);
          if (other !== undefined && other !== spec.name) {
            log.warn(
              "web:mcp",
              `servers "${other}" and "${spec.name}" both set ${variable}; the latter wins`,
            );
          }
          seen.set(variable, spec.name);
        }
      }
      return servers;
    },
  };
}
