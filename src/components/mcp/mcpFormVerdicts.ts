/**
 * Every verdict the server editor reaches about the form in hand — the
 * library-generic ones ([`libraryVerdicts`]) composed with the two that are
 * a server's own (its body, and the key/value blocks the form types as
 * lines), and `canSave`, the verdict the write machine gates on.
 */
import {
  mcpServerBodyProblem,
  mcpServerNameProblem,
  sameMcpScope,
  type McpServerBodyProblem,
} from "../../domain/mcp";
import {
  libraryVerdicts,
  type LibraryVerdicts,
  type Selection as LibrarySelection,
} from "../library/libraryVerdicts";
import type { EditorWorld } from "../library/useLibraryEditor";
import { draftOfForm, keyValueLinesProblem, type McpEditorScope, type McpForm, type McpRow } from "./mcpForm";

export type Selection = LibrarySelection<McpEditorScope>;

/** Whether two dialog scopes name the same library or tier. */
export function sameMcpEditorScope(a: McpEditorScope, b: McpEditorScope): boolean {
  if (a.kind === "bundled" || b.kind === "bundled") return a.kind === b.kind;
  return sameMcpScope(a, b);
}

/** The listed row at (scope, name) — "which row IS this one" asked once. */
export function mcpRowAt(
  rows: McpRow[] | null,
  scope: McpEditorScope,
  name: string,
): McpRow | undefined {
  return (rows ?? []).find((row) => row.name === name && sameMcpEditorScope(row.scope, scope));
}

export interface McpFormVerdicts extends Omit<LibraryVerdicts, "retitled"> {
  /** What the body cannot be saved with — a missing field, or two credentials. */
  bodyProblem: McpServerBodyProblem;
  /** The first line of the environment (or headers) block that is not a
   * pair, when there is one — the save is refused rather than the line
   * silently dropped. */
  badLine: string | null;
  canSave: boolean;
}

export function mcpFormVerdicts(world: EditorWorld<McpEditorScope, McpRow, McpForm>): McpFormVerdicts {
  const { retitled, ...shared } = libraryVerdicts({
    ...world,
    rowAt: mcpRowAt,
    nameProblemOf: mcpServerNameProblem,
  });
  const { form } = world;
  const bodyProblem = mcpServerBodyProblem(draftOfForm(form).body);
  const badLine =
    form.transport === "stdio"
      ? keyValueLinesProblem(form.env, "=")
      : keyValueLinesProblem(form.headers, ":");

  const canSave =
    world.selection !== null &&
    !shared.isView &&
    world.dirty &&
    (!shared.vanished || retitled) &&
    shared.nameProblem === null &&
    !shared.nameTaken &&
    bodyProblem === null &&
    badLine === null;

  return Object.freeze({ ...shared, bodyProblem, badLine, canSave });
}
