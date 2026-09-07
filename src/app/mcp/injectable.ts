/**
 * One stored library server, as the injection hands it to a hook: the spec a
 * dialect renders, and the values that spec only NAMES.
 *
 * A library file may hold literal values — the variables a spawned server
 * reads, the bearer token an endpoint wants — and none of them may enter a
 * CLI's config, because several CLIs take that config on argv where `ps`
 * reads it. So the spec names each value by an environment variable, and the
 * pair travels beside it for the plan to put in the pane's environment: a
 * spawned server's variables under the names the server itself expects
 * (declared as a passthrough for the one CLI that filters its children's
 * environment), and an endpoint's token under a name this module mints.
 *
 * WHICH fields are secrets is the domain's statement (`mcpServerSummary`);
 * this module reads that answer rather than making its own.
 */
import type { McpServerSpec } from "@keepdeck/plugin-api";
import { mcpServerSummary, type McpServerBody } from "../../domain/mcp";
import type { McpInjectable } from "./injection";

/**
 * The pane environment variable a remote server's bearer token rides in.
 *
 * Minted from the server's name INJECTIVELY: `-` and `_` are spelled as
 * their own hex (`_2D`, `_5F`), so two distinct names never share a variable
 * — `github-remote` and `github_remote` used to, and the pane then handed
 * one server the other's token. Case is kept, since environment names are
 * case-sensitive on every platform KeepDeck runs on. Stable, so a hook's
 * rendered reference and the plan's pair cannot disagree.
 */
export function bearerTokenVar(name: string): string {
  const escaped = name.replace(/[_-]/g, (c) => `_${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `KEEPDECK_MCP_TOKEN_${escaped}`;
}

export function injectableOf(name: string, body: McpServerBody): McpInjectable {
  const summary = mcpServerSummary(body);
  if (body.transport === "stdio" && summary.transport === "stdio") {
    const spec: McpServerSpec = {
      name,
      transport: "stdio",
      command: body.command,
      args: body.args,
      ...(summary.env.length > 0 ? { envPassthrough: summary.env } : {}),
    };
    return { spec, env: summary.env.map((variable) => [variable, body.env[variable] ?? ""]) };
  }
  if (body.transport === "http" && summary.transport === "http") {
    const tokenVar = summary.bearerToken ? bearerTokenVar(name) : null;
    const spec: McpServerSpec = {
      name,
      transport: "http",
      url: body.url,
      ...(Object.keys(body.headers).length > 0 ? { headers: body.headers } : {}),
      ...(tokenVar ? { bearerTokenEnv: tokenVar } : {}),
    };
    return {
      spec,
      env: tokenVar && body.bearerToken !== undefined ? [[tokenVar, body.bearerToken]] : [],
    };
  }
  // The two unions move together; a transport the summary does not know is
  // a bug at the domain, not a value to render.
  throw new Error(`unsupported MCP transport: ${String(body.transport)}`);
}
