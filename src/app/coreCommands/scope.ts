import type { ArgSpec, CommandArgs, CommandSource } from "../../domain/commands";
import { requiredStr } from "./args";
import { findWorkspace } from "../../domain/deck";
import type { Deck } from "../useDeck";

/**
 * How a library command reads WHICH library it is asked about.
 *
 * Shared by every per-workspace library the deck exposes (skills, MCP
 * servers): the argument, its wording, and the rule that resolves
 * "workspace" to an id have one home, so an agent learns the rule once and
 * a second library cannot drift from the first.
 */

/** The two libraries a command can name. Structurally the scope every
 * library's domain declares, minus whatever extra kinds one of them keeps
 * for itself (skills' bundled tier is never a command's target). */
export type LibraryScope = { kind: "global" } | { kind: "workspace"; wsId: string };

export const SCOPE: ArgSpec = {
  name: "scope",
  type: "string",
  required: true,
  description:
    'Which library to touch: "global" for every workspace, or "workspace" for the caller\'s own workspace',
};

/** Read `scope` as a library.
 *
 * The workspace arm deliberately takes NO id argument. An external caller is a
 * pane, and a pane belongs to exactly one workspace — letting it name an
 * arbitrary id would let an agent in one workspace write into another's
 * library. A host or plugin caller has no pane, so for them the workspace on
 * screen is the only thing "this workspace" can mean.
 */
export function libraryScopeOf(
  args: CommandArgs,
  source: CommandSource,
  deck: () => Deck,
): LibraryScope {
  // Read ONCE, through the shared reader — and report the value that was
  // judged, not the raw wire value with its whitespace.
  const scope = requiredStr(args, SCOPE.name);
  if (scope === "global") return { kind: "global" };
  if (scope !== "workspace") {
    throw new Error(`scope must be "global" or "workspace", not "${scope}"`);
  }
  if (source.kind === "external") {
    if (!source.pane) {
      throw new Error(
        'this client is not tied to a pane, so it has no workspace — use scope "global"',
      );
    }
    return { kind: "workspace", wsId: source.pane.workspaceId };
  }
  // Resolve the workspace, not just its id, through the DOMAIN's by-id
  // selector: `activeId` is a plain string whose "none" is `""`, and it can
  // outlive the workspace it names, so an id check alone would let a stale id
  // build a scope pointing at a library that is gone.
  const current = deck();
  const active = findWorkspace(current.workspaces, current.activeId);
  if (!active) {
    throw new Error('no workspace is open, so there is no workspace library — use scope "global"');
  }
  return { kind: "workspace", wsId: active.id };
}
