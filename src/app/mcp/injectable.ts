/**
 * One stored library server, as the injection hands it to a hook: the spec a
 * dialect renders, and the values that spec only NAMES.
 *
 * The one home of the secrets rule. A library file may hold literal values —
 * the variables a spawned server reads, the bearer token an endpoint wants —
 * and none of them may enter a CLI's config, because several CLIs take that
 * config on argv where `ps` reads it. So the spec names each value by an
 * environment variable, and the pair travels beside it for the plan to put
 * in the pane's environment: a spawned server's variables under the names
 * the server itself expects (declared as a passthrough for the one CLI that
 * filters its children's environment), and an endpoint's token under a name
 * this module mints for it.
 */
import type { McpServerSpec } from "@keepdeck/plugin-api";
import type { McpServerBody } from "../../domain/mcp";
import type { McpLibraryServer } from "./injection";

/** The pane environment variable a remote server's bearer token rides in.
 * Minted from the server's name — `[A-Za-z0-9_-]` — so it is always a valid
 * variable name, and stable, so a hook's rendered reference and the plan's
 * pair cannot disagree. */
export function bearerTokenVar(name: string): string {
  return `KEEPDECK_MCP_${name.toUpperCase().replace(/-/g, "_")}_TOKEN`;
}

export function injectableOf(name: string, body: McpServerBody): McpLibraryServer {
  if (body.transport === "stdio") {
    const names = Object.keys(body.env);
    const spec: McpServerSpec = {
      name,
      transport: "stdio",
      command: body.command,
      args: body.args,
      ...(names.length > 0 ? { envPassthrough: names } : {}),
    };
    return { spec, env: Object.entries(body.env) };
  }
  const tokenVar = body.bearerToken !== undefined ? bearerTokenVar(name) : null;
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
