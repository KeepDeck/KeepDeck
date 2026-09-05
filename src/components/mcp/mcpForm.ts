/**
 * The server editor's FORM — the text a person types — and how it becomes
 * the draft the library takes, and back.
 *
 * Presentation, not domain: a list of arguments is one per line here and an
 * array there, an environment is `NAME=value` lines here and a map there. The
 * conversions are pure and live in this one object so the editor renders
 * strings and the machine saves drafts, and neither knows the other's shape.
 */
import type { McpScope, McpServerDraft, McpServerVerdict } from "../../domain/mcp";

/** The scopes the dialog shows: the two the library stores, and the tier
 * KeepDeck ships — read-only, and not a library at all. */
export type McpEditorScope = McpScope | { kind: "bundled" };

/** One row as the dialog lists it: a library row, or a bundled server
 * presented the same way so one nav can show both. */
export interface McpRow {
  scope: McpEditorScope;
  name: string;
  verdict: McpServerVerdict;
}

export interface McpForm {
  name: string;
  transport: "stdio" | "http";
  command: string;
  /** One argument per line. */
  args: string;
  /** One `NAME=value` per line. */
  env: string;
  url: string;
  /** One `Name: value` per line. */
  headers: string;
  bearerToken: string;
}

export const EMPTY_MCP_FORM: McpForm = {
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  env: "",
  url: "",
  headers: "",
  bearerToken: "",
};

/** A key/value block as lines, one pair per line. */
const linesOf = (map: Record<string, string>, sep: string): string =>
  Object.entries(map)
    .map(([key, value]) => `${key}${sep}${value}`)
    .join("\n");

/** The form for a stored draft. Both transports' fields are filled from the
 * one the draft has, so switching transport in the editor starts blank on
 * the other side rather than inheriting a stale value. */
export function formOfDraft(draft: McpServerDraft): McpForm {
  const { body } = draft;
  if (body.transport === "stdio") {
    return {
      ...EMPTY_MCP_FORM,
      name: draft.name,
      transport: "stdio",
      command: body.command,
      args: body.args.join("\n"),
      env: linesOf(body.env, "="),
    };
  }
  return {
    ...EMPTY_MCP_FORM,
    name: draft.name,
    transport: "http",
    url: body.url,
    headers: linesOf(body.headers, ": "),
    bearerToken: body.bearerToken ?? "",
  };
}

/** The form for a listed row. A file the codec could not read opens with the
 * name alone: what the user types replaces it, which is the repair. */
export function formOfRow(row: McpRow): McpForm {
  return row.verdict.kind === "ok"
    ? formOfDraft({ name: row.name, body: row.verdict.body })
    : { ...EMPTY_MCP_FORM, name: row.name };
}

/** What is wrong with a key/value block, or `null`: the first line that is
 * not `key<sep>value`. Blank lines are skipped, keys and values trimmed. */
export function keyValueLinesProblem(text: string, sep: "=" | ":"): string | null {
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const at = line.indexOf(sep);
    if (at <= 0 || line.slice(0, at).trim() === "") return line;
  }
  return null;
}

function keyValues(text: string, sep: "=" | ":"): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const at = line.indexOf(sep);
    if (at <= 0) continue;
    map[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return map;
}

/** The lines of a block, blank ones dropped, each trimmed. */
const lines = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** The draft a form describes. Assumes the form passed its verdicts — a
 * malformed key/value line is dropped here, which is why the verdict refuses
 * the save first. */
export function draftOfForm(form: McpForm): McpServerDraft {
  if (form.transport === "stdio") {
    return {
      name: form.name,
      body: {
        transport: "stdio",
        command: form.command.trim(),
        args: lines(form.args),
        env: keyValues(form.env, "="),
      },
    };
  }
  const token = form.bearerToken.trim();
  return {
    name: form.name,
    body: {
      transport: "http",
      url: form.url.trim(),
      headers: keyValues(form.headers, ":"),
      ...(token !== "" ? { bearerToken: token } : {}),
    },
  };
}
