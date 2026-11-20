/**
 * What a person is told when they asked about a pane, or about a team's
 * members: each pane named by the title they see it under, read from the
 * deck as it stood BEFORE the ask — the ask can change it, and the sentence
 * is about what the person clicked.
 */
import type { AgentInfo } from "../domain/agents";
import { findWorkspace, paneDisplayTitle, type Workspace } from "../domain/deck";
import type { MemberAnswer } from "../domain/lifecycle";

/** The label for a pane the deck no longer shows. */
export const UNKNOWN_PANE = "That agent";

/** Every pane of the workspace by the title the person sees it under. */
export function paneLabelsIn(workspaces: Workspace[], agents: AgentInfo[], wsId: string): Map<string, string> {
  const panes = findWorkspace(workspaces, wsId)?.panes ?? [];
  return new Map(panes.map((pane, index) => [pane.id, paneDisplayTitle(pane, index, agents)]));
}

/** What a team's act says: one sentence per member it did not take, a line
 * each, in the act's order — or null when it took every one. */
export function membersNotTakenText<Outcome>(
  answers: readonly MemberAnswer<Outcome>[],
  labels: ReadonlyMap<string, string>,
  textOf: (outcome: Outcome, label: string) => string | null,
): string | null {
  const said = answers.flatMap(({ paneId, outcome }) => {
    const text = textOf(outcome, labels.get(paneId) ?? UNKNOWN_PANE);
    return text === null ? [] : [text];
  });
  return said.length === 0 ? null : said.join("\n");
}
