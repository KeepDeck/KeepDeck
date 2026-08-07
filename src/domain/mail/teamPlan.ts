/**
 * A team as ONE thing to settle, rather than a pane at a time.
 *
 * Setting members one by one cannot answer the question that actually
 * matters — "are these roles a valid team?" — because it never sees the
 * whole. Two panes can each be assigned `impl-1` legitimately a second
 * apart, and only a view of the finished roster catches it. So the surface
 * collects a DRAFT, this settles it into a plan, and applying the plan is
 * mechanical.
 *
 * The plan also carries who LEAVES. A team is the set of panes holding its
 * name, so anyone in it that the draft no longer lists has been taken out —
 * saying so explicitly is what lets the caller apply the result without
 * re-deriving it, and re-derivation at the call site is how a member gets
 * silently stranded on a team nobody thinks they are on.
 */
import type { AgentType } from "../agents";
import type { Resolved } from "../commands";
import type { Workspace } from "../deck";

/** An existing pane taking a role. */
export interface TeamMemberDraft {
  paneId: string;
  role: string;
}

/** An agent to spawn INTO the team, with the role it will answer to. */
export interface TeamRecruitDraft {
  agentType: AgentType;
  role: string;
}

/** What the surface holds while the person is still deciding. */
export interface TeamDraft {
  name: string;
  members: TeamMemberDraft[];
  recruits: TeamRecruitDraft[];
}

/** A settled team, in the order it has to be applied. */
export interface TeamPlan {
  name: string;
  members: { paneId: string; role: string }[];
  /** Panes leaving the team — everyone holding its name that the draft
   * dropped. */
  released: string[];
  recruits: { agentType: AgentType; role: string }[];
}

/**
 * The team this workspace is running, or null.
 *
 * The SURFACE assumes one team per workspace — a workspace is a piece of
 * work, and the people setting it up think of "the team on it". The data
 * model does not enforce that: `Pane.team` is per pane, so an agent driving
 * `team.assign` over MCP can make two. When that happens this names the
 * first one found rather than inventing a summary, and the dialog edits
 * that one; the other stays exactly as it was, reachable the same way it
 * was made.
 */
export function teamNameIn(workspace: Workspace): string | null {
  for (const pane of workspace.panes) {
    if (pane.team) return pane.team.name;
  }
  return null;
}

/** Whether the plan asks for anything at all. A dialog confirmed without a
 * change should do nothing rather than dispatch a no-op storm. */
export function teamPlanIsEmpty(plan: TeamPlan): boolean {
  return (
    plan.members.length === 0 &&
    plan.released.length === 0 &&
    plan.recruits.length === 0
  );
}

/**
 * Settle a draft against the workspace, or say what is wrong with it.
 *
 * Uniqueness is judged across members AND recruits together, because a role
 * an about-to-be-spawned agent will hold is just as taken as one a live pane
 * holds — checking only the live half is how a team ends up with two
 * `impl-1`s the moment the second one starts.
 */
export function planTeam(
  workspace: Workspace,
  draft: TeamDraft,
): Resolved<TeamPlan> {
  const name = draft.name.trim();
  if (!name) return { ok: false, message: "the team needs a name" };

  const members = draft.members.map((member) => ({
    paneId: member.paneId,
    role: member.role.trim(),
  }));
  const recruits = draft.recruits.map((recruit) => ({
    agentType: recruit.agentType,
    role: recruit.role.trim(),
  }));

  if ([...members, ...recruits].some((entry) => !entry.role)) {
    return {
      ok: false,
      message: "every member needs a role — it is the address teammates use",
    };
  }

  const seen = new Set<string>();
  for (const { role } of [...members, ...recruits]) {
    const key = role.toLowerCase();
    if (seen.has(key)) {
      return {
        ok: false,
        message: `two members share the role "${role}" — a role is an address, so it has to be unique`,
      };
    }
    seen.add(key);
  }

  // Everyone currently holding this team's name that the draft dropped.
  // Compared case-insensitively for the same reason the roles are: the
  // person typing "API" means the team they called "api".
  const needle = name.toLowerCase();
  const keeping = new Set(members.map((member) => member.paneId));
  const released = workspace.panes
    .filter(
      (pane) =>
        pane.team?.name.toLowerCase() === needle && !keeping.has(pane.id),
    )
    .map((pane) => pane.id);

  return { ok: true, value: { name, members, released, recruits } };
}
