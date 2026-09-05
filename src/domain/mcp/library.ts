/**
 * The user's library of MCP servers ([mcp] — one definition, every CLI).
 *
 * A server is one small JSON document under KeepDeck's home; its NAME is the
 * file's name, so the two cannot drift. The Rust `mcp/library` adapter moves
 * the bytes; this module owns the RULES — where a server lives, what a stored
 * body is, what makes a name acceptable to every client — and the codec that
 * reads and writes the file.
 *
 * The shape is CLOSED and read strictly. Each CLI's config schema is strict
 * too, and the implementation this replaces let a free-form "extras" bag
 * through: one wrong-typed key took every codex or opencode pane down with
 * it. A key this app cannot render is a key no agent would get, so a file
 * carrying one is reported as malformed rather than half-served.
 */

/** Where a server lives — its distribution boundary. */
export type McpScope = { kind: "global" } | { kind: "workspace"; wsId: string };

/** Whether two scopes name the SAME library. Here rather than at a call site
 * because every surface that groups, filters or looks a server up asks it. */
export function sameMcpScope(a: McpScope, b: McpScope): boolean {
  if (a.kind === "global") return b.kind === "global";
  return b.kind === "workspace" && a.wsId === b.wsId;
}

/** The scope a stored server lives in. Takes the stored row's shape
 * structurally — the domain must not reach for the IPC type that mirrors it. A
 * workspace row with no id keeps an empty id, which matches no real workspace
 * and so stays out of every live library. */
export function mcpScopeOf(stored: {
  scope: "global" | "workspace";
  wsId: string | null;
}): McpScope {
  return stored.scope === "global"
    ? { kind: "global" }
    : { kind: "workspace", wsId: stored.wsId ?? "" };
}

/** A scope as a stable string — for a React key, a map key, a log line. */
export const mcpScopeKey = (scope: McpScope): string =>
  scope.kind === "global" ? "global" : `ws:${scope.wsId}`;

/** A server the CLI spawns. `env` holds the literal values the process needs
 * — the library is the one place they are stored; how they reach the process
 * (never on argv) is the injection's business. */
export interface McpStdioBody {
  transport: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** A server the CLI reaches. `headers` are literal; the bearer token, when
 * there is one, is stored here and referenced from the config by name. */
export interface McpHttpBody {
  transport: "http";
  url: string;
  headers: Record<string, string>;
  bearerToken?: string;
}

export type McpServerBody = McpStdioBody | McpHttpBody;

/** A server as the editor and the commands work with it. */
export interface McpServerDraft {
  name: string;
  body: McpServerBody;
}

/** The naming rule in words, for whoever has to explain a refusal. */
export const MCP_SERVER_NAME_RULE =
  "letters, digits, hyphens and underscores, starting with a letter or digit, 64 characters at most";

/** A server name must survive every client's tool-name grammar (`[A-Za-z0-9_-]`,
 * no dots — tool names flatten namespaces with underscores precisely because
 * external grammars refuse dots) AND the path wall the file is stored behind
 * (a plain segment, starting alphanumeric). The intersection, stated once. */
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isValidMcpServerName(name: string): boolean {
  return SERVER_NAME.test(name);
}

/** What is wrong with a server name, or `null` when nothing is. A VERDICT
 * rather than a predicate: a caller needs the same answer for its gate and
 * for what it puts on screen. */
export function mcpServerNameProblem(name: string): "empty" | "invalid" | null {
  if (name.trim() === "") return "empty";
  return isValidMcpServerName(name) ? null : "invalid";
}

/** What is wrong with a body a caller authored, or `null` when nothing is.
 * The stored-file reader refuses the same things; this is the authoring-time
 * verdict so a form can say which field. */
export function mcpServerBodyProblem(
  body: McpServerBody,
): "empty-command" | "empty-url" | null {
  if (body.transport === "stdio") {
    return body.command.trim() === "" ? "empty-command" : null;
  }
  return body.url.trim() === "" ? "empty-url" : null;
}

/** A body as it may leave the app through a door that must not carry a
 * credential: a spawned server's environment by NAME only, an endpoint's
 * token as a yes or no. The one statement of which fields are secrets. */
export type McpServerSummary =
  | { transport: "stdio"; command: string; args: string[]; env: string[] }
  | { transport: "http"; url: string; headers: Record<string, string>; bearerToken: boolean };

export function mcpServerSummary(body: McpServerBody): McpServerSummary {
  return body.transport === "stdio"
    ? {
        transport: "stdio",
        command: body.command,
        args: body.args,
        env: Object.keys(body.env),
      }
    : {
        transport: "http",
        url: body.url,
        headers: body.headers,
        bearerToken: body.bearerToken !== undefined,
      };
}

/** What a stored file turned out to hold: a body, or the reason it is not one. */
export type McpServerVerdict =
  | { kind: "ok"; body: McpServerBody }
  | { kind: "malformed"; reason: string };

const malformed = (reason: string): McpServerVerdict => ({ kind: "malformed", reason });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A required non-empty string field, or the reason it is not one. */
function requiredText(
  raw: Record<string, unknown>,
  field: string,
): { value: string } | { reason: string } {
  const value = raw[field];
  if (typeof value !== "string" || value.trim() === "") {
    return { reason: `"${field}" must be a non-empty string` };
  }
  return { value };
}

/** An optional string→string map, absent meaning empty. */
function stringMap(
  raw: Record<string, unknown>,
  field: string,
): { value: Record<string, string> } | { reason: string } {
  const value = raw[field];
  if (value === undefined) return { value: {} };
  if (!isRecord(value) || !Object.values(value).every((v) => typeof v === "string")) {
    return { reason: `"${field}" must be an object of strings` };
  }
  return { value: { ...value } as Record<string, string> };
}

/** The keys a body may carry, per transport — anything else is refused. */
const KNOWN_KEYS: Record<McpServerBody["transport"], readonly string[]> = {
  stdio: ["transport", "command", "args", "env"],
  http: ["transport", "url", "headers", "bearerToken"],
};

/**
 * Read a stored file. Strict: a transport this build does not know, a field
 * of the wrong type, or a key no renderer would carry all make the file
 * malformed — with the reason, so the user can fix the file by hand.
 */
export function parseMcpServerFile(content: string): McpServerVerdict {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (e) {
    return malformed(`not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isRecord(raw)) return malformed("the file must hold a JSON object");
  const transport = raw.transport;
  if (transport !== "stdio" && transport !== "http") {
    return malformed('"transport" must be "stdio" or "http"');
  }
  const unknown = Object.keys(raw).find((key) => !KNOWN_KEYS[transport].includes(key));
  if (unknown !== undefined) return malformed(`unknown field "${unknown}"`);

  if (transport === "stdio") {
    const command = requiredText(raw, "command");
    if ("reason" in command) return malformed(command.reason);
    const args = raw.args ?? [];
    if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
      return malformed('"args" must be an array of strings');
    }
    const env = stringMap(raw, "env");
    if ("reason" in env) return malformed(env.reason);
    return {
      kind: "ok",
      body: { transport, command: command.value, args: [...args], env: env.value },
    };
  }

  const url = requiredText(raw, "url");
  if ("reason" in url) return malformed(url.reason);
  const headers = stringMap(raw, "headers");
  if ("reason" in headers) return malformed(headers.reason);
  const token = raw.bearerToken;
  if (token !== undefined && (typeof token !== "string" || token === "")) {
    return malformed('"bearerToken" must be a non-empty string');
  }
  return {
    kind: "ok",
    body: {
      transport,
      url: url.value,
      headers: headers.value,
      ...(typeof token === "string" ? { bearerToken: token } : {}),
    },
  };
}

/** Compose the stored file for a body: stable key order, an empty map left
 * out (a hand editor reads what matters), and a trailing newline. Assumes a
 * body [`mcpServerBodyProblem`] accepts. */
export function composeMcpServerFile(body: McpServerBody): string {
  const nonEmpty = (map: Record<string, string>) =>
    Object.keys(map).length > 0 ? map : undefined;
  const document =
    body.transport === "stdio"
      ? {
          transport: body.transport,
          command: body.command,
          args: body.args,
          ...(nonEmpty(body.env) ? { env: body.env } : {}),
        }
      : {
          transport: body.transport,
          url: body.url,
          ...(nonEmpty(body.headers) ? { headers: body.headers } : {}),
          ...(body.bearerToken !== undefined ? { bearerToken: body.bearerToken } : {}),
        };
  return `${JSON.stringify(document, null, 2)}\n`;
}
