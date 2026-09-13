import type { RootFact } from "../domain/roots";

/**
 * What the root picker prints for one repository — the view model behind
 * each option. A team's tree reads as the team: its name first, the branch
 * beside it, the folder underneath (the open list only; the closed control
 * has no room). A tree no team claims falls back to its branch, then to the
 * folder's own name. The workspace folder says so.
 */
export interface RootOption {
  value: string;
  /** The line the closed control shows. */
  title: string;
  /** Beside the title, dimmer: the branch when the title is a team name. */
  detail?: string;
  /** The folder line of the open list. */
  folder?: string;
  /** Hover text: the full path, and how many agents run there. */
  hint: string;
}

export function rootOptions(facts: RootFact[]): RootOption[] {
  return facts.map((fact) => {
    const agents = `${fact.agents} ${fact.agents === 1 ? "agent" : "agents"}`;
    if (fact.workspace) {
      return { value: fact.cwd, title: "Workspace folder", hint: `${fact.cwd} · ${agents}` };
    }
    const folder = lastSegment(fact.cwd);
    if (fact.team) {
      return {
        value: fact.cwd,
        title: fact.team.name,
        ...(fact.branch !== undefined && { detail: fact.branch }),
        folder,
        hint: `${fact.cwd} · ${agents}`,
      };
    }
    return {
      value: fact.cwd,
      title: fact.branch ?? folder,
      ...(fact.branch !== undefined && { folder }),
      hint: `${fact.cwd} · ${agents}`,
    };
  });
}

/** The folder's own name. */
function lastSegment(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
