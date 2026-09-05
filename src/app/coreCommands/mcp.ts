import type { ArgSpec, CommandArgs, CommandRegistry, CommandSource } from "../../domain/commands";
import { mcpServerSummary, parseMcpServerFile } from "../../domain/mcp";
import type { McpLibrary } from "../mcpLibrary";
import type { Deck } from "../useDeck";
import { requiredStr, text } from "./args";
import { SCOPE, libraryScopeOf } from "./scope";

/**
 * The MCP-server library as commands — the CRUD half of the deck's control
 * surface for MCP servers, the twin of `./skills`. Registered in the core set,
 * not inside a transport, because the registry is the single door every
 * invoker comes through: MCP projects these into tools, and voice, hotkeys
 * and a future palette get them for free.
 *
 * A server's definition is ONE JSON document — the same document the library
 * keeps on disk — passed as the `spec` argument. The two transports carry
 * different fields and the registry's arguments are flat primitives, so the
 * codec that reads the file reads the argument too, with the same strictness
 * and the same words; a caller learns one format.
 *
 * Nothing that leaves through these commands carries a credential: a listing
 * or a read names a server's variables and says whether a token is set. An
 * agent that needs to change one sends a whole spec.
 */

export interface McpCommandDeps {
  deck(): Deck;
  library: McpLibrary;
}

const NAME: ArgSpec = {
  name: "name",
  type: "string",
  required: true,
  description:
    "The server's name — the key every agent files it under, and the prefix of its tools (letters, digits, hyphens, underscores)",
};

const SPEC: ArgSpec = {
  name: "spec",
  type: "string",
  required: true,
  description:
    'The server as JSON. A process the agent spawns: {"transport":"stdio","command":"npx","args":["-y","@scope/server"],"env":{"API_TOKEN":"…"}}. An endpoint it reaches: {"transport":"http","url":"https://…","headers":{"X-Org":"…"},"bearerToken":"…"}. Values under env and bearerToken are stored privately and reach the server through its environment, never through a config file; nothing else is accepted.',
};

/** The body a `spec` argument holds, read by the file's own codec — or the
 * codec's refusal, worded for the caller. */
function bodyOf(args: CommandArgs) {
  const verdict = parseMcpServerFile(text(args, SPEC.name));
  if (verdict.kind === "malformed") throw new Error(`spec: ${verdict.reason}`);
  return verdict.body;
}

export function registerMcpCommands(
  registry: CommandRegistry,
  deps: McpCommandDeps,
): (() => void)[] {
  const library = deps.library;
  const scope = (args: CommandArgs, source: CommandSource) =>
    libraryScopeOf(args, source, deps.deck);

  return [
    registry.register({
      id: "mcp.list",
      title: "List MCP servers",
      args: [SCOPE],
      run: async (args, source) =>
        (await library.list(scope(args, source))).map((row) =>
          row.verdict.kind === "ok"
            ? { name: row.name, ...mcpServerSummary(row.verdict.body) }
            : // A file the codec cannot read is still listed, with its reason:
              // hidden, the caller could neither fix nor delete it.
              { name: row.name, malformed: row.verdict.reason },
        ),
    }),

    registry.register({
      id: "mcp.read",
      title: "Read an MCP server",
      args: [SCOPE, NAME],
      run: async (args, source) => {
        const draft = await library.read(scope(args, source), requiredStr(args, NAME.name));
        return { name: draft.name, ...mcpServerSummary(draft.body) };
      },
    }),

    registry.register({
      id: "mcp.create",
      title: "Create an MCP server",
      args: [SCOPE, NAME, SPEC],
      run: async (args, source) => {
        const name = requiredStr(args, NAME.name);
        await library.create(scope(args, source), { name, body: bodyOf(args) });
        return { name };
      },
    }),

    registry.register({
      id: "mcp.update",
      title: "Update an MCP server",
      args: [SCOPE, NAME, SPEC],
      run: async (args, source) => {
        const name = requiredStr(args, NAME.name);
        await library.update(scope(args, source), { name, body: bodyOf(args) });
        return { name };
      },
    }),

    registry.register({
      id: "mcp.rename",
      title: "Rename an MCP server",
      args: [
        SCOPE,
        { name: "from", type: "string", required: true, description: "The server's current name" },
        { name: "to", type: "string", required: true, description: "Its new name" },
      ],
      run: async (args, source) => {
        const to = requiredStr(args, "to");
        await library.rename(scope(args, source), requiredStr(args, "from"), to);
        return { name: to };
      },
    }),

    registry.register({
      id: "mcp.delete",
      title: "Delete an MCP server",
      args: [SCOPE, NAME],
      run: async (args, source) => {
        const name = requiredStr(args, NAME.name);
        await library.remove(scope(args, source), name);
        return { name };
      },
    }),
  ];
}
