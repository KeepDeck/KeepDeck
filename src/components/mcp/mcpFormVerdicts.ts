/**
 * Every verdict the server editor reaches about the form in hand — the
 * library-generic ones ([`libraryVerdicts`]) composed with the two that are
 * a server's own (its body, and the key/value blocks the form types as
 * lines), and `canSave`, the verdict the write machine gates on.
 */
import {
  mcpServerBodyProblem,
  mcpServerNameProblem,
  type McpScope,
  type McpServerBodyProblem,
} from "../../domain/mcp";
import {
  libraryVerdicts,
  type LibraryVerdicts,
  type Selection as LibrarySelection,
} from "../library/libraryVerdicts";
import type { EditorWorld } from "../library/useLibraryEditor";
import { draftOfForm, keyValueLinesProblem, type McpForm } from "./mcpForm";
import { mcpRowAt, type McpRow } from "./mcpRows";

/** Which server the editor shows: an edit or a create names a LIBRARY scope;
 * the view mode is a bundled row and names none. */
export type Selection = LibrarySelection<McpScope>;

export interface McpFormVerdicts extends Omit<LibraryVerdicts, "retitled"> {
  /** What the body cannot be saved with — a missing field, or two credentials. */
  bodyProblem: McpServerBodyProblem;
  /** The first line of the environment (or headers) block that is not a
   * pair, when there is one — the save is refused rather than the line
   * silently dropped. */
  badLine: string | null;
  /** The open file could not be read, and this is why: the editor holds the
   * name alone, and what is saved replaces the file. `null` otherwise. */
  repairReason: string | null;
  canSave: boolean;
}

export function mcpFormVerdicts(world: EditorWorld<McpScope, McpRow, McpForm>): McpFormVerdicts {
  const { retitled, ...shared } = libraryVerdicts({
    ...world,
    rowAt: mcpRowAt,
    nameProblemOf: mcpServerNameProblem,
  });
  const { form, selection, rows } = world;
  const open = selection?.mode === "edit" ? mcpRowAt(rows, selection.scope, selection.name) : undefined;
  const repairReason = open?.verdict.kind === "malformed" ? open.verdict.reason : null;
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

  return Object.freeze({ ...shared, bodyProblem, badLine, repairReason, canSave });
}
