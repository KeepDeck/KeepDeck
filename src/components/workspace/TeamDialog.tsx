import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  agentSupportsNew,
  agentSupportsYolo,
  selectableAgents,
  type AgentInfo,
} from "../../domain/agents";
import {
  baseName,
  findTeam,
  membersOf,
  paneAgentType,
  paneBranch,
  paneDisplayTitle,
  paneWorktree,
  type Pane,
  type Workspace,
} from "../../domain/deck";
import {
  mintRoleAddress,
  parseRoleAddress,
  planTeam,
  roleById,
  suggestRoleAddress,
  teamBriefing,
  teamPlanIsNoop,
  teamRoles,
  type TeamPlan,
  type TeamRecruitDraft,
} from "../../domain/mail";
import { activityBadge, type PaneActivity } from "../../domain/status";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { ModalOverlay } from "../../ui/ModalOverlay";
import { AgentGlyph } from "../../ui/AgentGlyph";
import { Dropdown } from "../../ui/Dropdown";
import { useEscape } from "../../ui/useEscape";
import { noAutoCorrect } from "../../ui/inputProps";

interface TeamDialogProps {
  workspace: Workspace;
  agents: AgentInfo[];
  /** The team whose roster and roles are settled here — by id. Its name is
   * an address the form can change; the id is what the plan carries. */
  teamId: string;
  /** The YOLO toggle's starting position for a new recruit — the global
   * preference, the same seed the "+ Agent" and fork dialogs use. */
  defaultYolo: boolean;
  /** Live agent activity, as the tray reads it — a port rather than a
   * context reach, so a test host without a status lane simply shows no
   * dots. The subscription lives per row, because only that row re-renders
   * when its pane's activity moves. `of` must answer a STABLE reference
   * between changes: it feeds useSyncExternalStore, which re-renders
   * forever on a fresh object per read. */
  activity?: {
    subscribe(listener: () => void): () => void;
    of(paneId: string): PaneActivity | undefined;
  };
  /** Apply a settled roster. */
  onConfirm(plan: TeamPlan): void;
  onCancel(): void;
}

/** The address a row gets when nobody has picked one — the catalog's own
 * suggestion, shared with the landing that puts an agent on a team without
 * a dialog. A duplicate can only come back for a singleton already taken,
 * and `planTeam` says so in words the person can act on. */
const suggestAddress = suggestRoleAddress;

/** What tells one pane from another when their titles do not. The branch
 * first — that is what an agent is actually working on — else the folder it
 * runs in. Empty when the pane has neither and the title is all there is. */
function whereOf(workspace: Workspace, pane: Pane): string {
  const branch = paneBranch(workspace, pane);
  if (branch) return branch;
  const worktree = paneWorktree(workspace, pane);
  return worktree ? baseName(worktree.cwd) : "";
}

/** One pane's live status — the tray's own badge model, rendered small. Its
 * own component because the subscription is per row, and a hook cannot sit
 * inside the roster loop. */
function RowActivity({
  source,
  paneId,
}: {
  source: NonNullable<TeamDialogProps["activity"]>;
  paneId: string;
}) {
  const activity = useSyncExternalStore(source.subscribe, () => source.of(paneId));
  const view = activity ? activityBadge(activity) : null;
  if (!view) return null;
  return (
    <span
      className={`team__row-activity team__row-activity--${view.tone}`}
      title={view.detail ? `${view.label} — ${view.detail}` : view.label}
    >
      <span className="team__row-activity-dot" />
      {view.label}
    </span>
  );
}

/**
 * The team's roster in one place: its name, who is on it, what each is
 * called, and any agents to start alongside them.
 *
 * A team is a workspace-level structure, so it is settled at that level
 * rather than a pane at a time. Editing membership one pane at a time can
 * never answer the question that decides whether a team WORKS — "are these
 * roles unique?" — because it never sees the whole roster; two panes can
 * each take `impl-1` a second apart and nothing is there to notice.
 *
 * What the roster is NOT: a way in or out of the team. An agent runs where
 * its team runs, so a member is never taken off here (closing it is the
 * close flow's), nobody is taken from another team, and the team itself
 * is born elsewhere, with its directory and its first agent. Disbanding is
 * the card's, through the same close flow. The dialog decides nothing
 * itself: it collects a draft and hands it to `planTeam`, which settles it
 * or says what is wrong.
 */
export function TeamDialog({
  workspace,
  agents,
  teamId,
  defaultYolo,
  activity,
  onConfirm,
  onCancel,
}: TeamDialogProps) {
  const team = findTeam(workspace, teamId);
  // The team can vanish under an open dialog (a disband over MCP). A form
  // over a team that is gone would settle nothing; closing it says the
  // moment passed.
  useEffect(() => {
    if (!team) onCancel();
  }, [team, onCancel]);

  const [name, setName] = useState(team?.name ?? "");
  /** The roles the person has PICKED, by pane. A member absent from the
   * map keeps the role it holds — so a member that joins while the dialog
   * is open (an agent's team.add) appears with its own role, not blank. */
  const [picked, setPicked] = useState<Map<string, string>>(() => new Map());
  const [recruits, setRecruits] = useState<TeamRecruitDraft[]>([]);
  /** Whether the person has done anything yet. A form that greets you with
   * a refusal is scolding you for not having typed — the complaint is only
   * true, and only useful, once something was attempted. */
  const [touched, setTouched] = useState(false);
  /** The roster row whose briefing is open in a notice over this dialog —
   * null when none is. */
  const [briefFor, setBriefFor] = useState<string | null>(null);

  const canRecruit = useMemo(
    () => selectableAgents(agents).filter((agent) => agentSupportsNew(agents, agent.id)),
    [agents],
  );
  /** The catalog, as the picker takes it. Roles are chosen, never typed —
   * a role carries what a member is FOR, and that only exists for one the
   * catalog has. */
  const roleOptions = useMemo(
    () => teamRoles().map((role) => ({ value: role.id, label: role.label })),
    [],
  );
  /** The catalog id behind a stored address, which is what the picker shows.
   * Empty for an address the catalog cannot account for — `planTeam` refuses
   * it, and an empty picker is the honest rendering of "no role yet". */
  const roleIdOf = (address: string) => parseRoleAddress(address)?.role.id ?? "";

  // The roster as the workspace holds it NOW, each member under the role
  // picked here or the one it already has. Read per render, so a member
  // closed while the dialog is open leaves the roster, and one that joined
  // appears on it.
  const members = membersOf(workspace, teamId).map((pane) => ({
    pane,
    role: picked.get(pane.id) ?? pane.team?.role ?? "",
  }));

  /** Every address the roster holds — the members' and the recruits'. ONE
   * list, because two paths mint against it: a role picked for a row, and
   * a fresh recruit. Takes the recruits explicitly rather than closing over
   * state, so a functional update can hand it the rows it is about to
   * commit rather than the ones of the last render. */
  const heldAddresses = (rows: readonly TeamRecruitDraft[]): string[] => [
    ...members.map((member) => member.role),
    ...rows.map((row) => row.role),
  ];

  /** Every address the roster holds, apart from one row's own — what a fresh
   * address has to avoid. */
  const addressesBesides = (mine: string): string[] =>
    heldAddresses(recruits).filter((address) => address !== mine);

  /** The address for a chosen ROLE. The picker answers with a catalog id; the
   * roster stores an address, because two implementers need telling apart.
   * A singleton already held comes back as itself, and the duplicate is
   * refused in words rather than swallowed by a click that does nothing. */
  const addressFor = (roleId: string, mine: string): string => {
    const role = roleById(roleId);
    if (!role) return mine;
    return mintRoleAddress(role, addressesBesides(mine)) ?? role.id;
  };

  const setRole = (paneId: string, roleId: string) => {
    setTouched(true);
    const mine = members.find((member) => member.pane.id === paneId)?.role ?? "";
    setPicked((current) => new Map(current).set(paneId, addressFor(roleId, mine)));
  };

  const iconOf = (pane: Pane) =>
    agents.find((agent) => agent.id === paneAgentType(pane))?.icon;

  const titleOf = (pane: Pane) =>
    paneDisplayTitle(pane, workspace.panes.indexOf(pane), agents);

  const draft = {
    name,
    members: members.map(({ pane, role }) => ({ paneId: pane.id, role })),
    recruits,
  };
  const planned = planTeam(workspace, draft, teamId);
  // Nothing to do is not an error, but it is not a confirmable form either:
  // a dialog that dispatches a no-op teaches people it did something.
  const valid = planned.ok && !teamPlanIsNoop(workspace, planned.value);

  /** The team as it currently stands: the members in deck order, then the
   * agents to start. One list, because to the person reading it they are
   * all members — the difference is only that some do not exist yet. */
  const roster = [
    ...members.map(({ pane, role }) => ({
      key: pane.id,
      role,
      pane: pane as Pane | null,
      label: titleOf(pane),
      agentType: "",
      yolo: false,
      setRole: (next: string) => setRole(pane.id, next),
      setAgentType: () => {},
      setYolo: () => {},
      remove: null as (() => void) | null,
    })),
    ...recruits.map((recruit, index) => ({
      key: `new-${index}`,
      role: recruit.role,
      pane: null,
      label: `the new ${recruit.agentType}`,
      agentType: recruit.agentType,
      yolo: recruit.yolo,
      setRole: (next: string) =>
        setRecruits((current) =>
          current.map((row, i) =>
            i === index ? { ...row, role: addressFor(next, row.role) } : row,
          ),
        ),
      setAgentType: (next: string) =>
        setRecruits((current) =>
          current.map((row, i) => (i === index ? { ...row, agentType: next } : row)),
        ),
      setYolo: (next: boolean) =>
        setRecruits((current) =>
          current.map((row, i) => (i === index ? { ...row, yolo: next } : row)),
        ),
      // Only an agent that does not exist yet can be dropped from the
      // roster: a member runs where its team runs, and ending it is the
      // close flow's own question.
      remove: () => setRecruits((current) => current.filter((_, i) => i !== index)),
    })),
  ];

  // The row whose briefing the notice quotes — re-found per render, so the
  // words stay live while the roster is edited under it, and a dropped row
  // simply closes it.
  const briefRow = roster.find((row) => row.key === briefFor) ?? null;

  // Escape closes the dialog, like every other one here — nothing has
  // happened yet, since settling a team as one plan is what makes leaving
  // mid-edit free. While a notice is STACKED over it, Escape is the top
  // surface's to claim, and the guard reads the same value the notice
  // renders from (briefRow, never the raw key) — so a stale key can never
  // leave the dialog deaf with nothing on screen.
  useEscape(onCancel, briefRow === null);

  // What the roster itself says the team's shape is. The label reads it
  // back, so a person assembling a flat team watches the deck agree — and
  // a mixed or unknown roster claims nothing, because planTeam is about to
  // say why in words.
  const standings = roster.map((row) => parseRoleAddress(row.role)?.role.standing);
  const shapeLabel =
    roster.length > 0 && standings.every((standing) => standing === "peer")
      ? "The team — flat, everyone equal"
      : standings.some((standing) => standing === "leads")
        ? "The team — led"
        : "The team";

  if (!team) return null;

  return (
    <ModalOverlay>
      <form
        className="form team-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (planned.ok && valid) onConfirm(planned.value);
        }}
      >
        <h2 className="form__title">Team “{team.name}”</h2>
        <p className="form__desc team__desc">
          Agents on a team can write to each other by role — “ask impl-1”,
          “report to lead”. The role is the address, so it has to be unique.
        </p>

        <span className="form__label">Team name</span>
        <input
          {...noAutoCorrect}
          className="form__input"
          value={name}
          onChange={(e) => {
            setTouched(true);
            setName(e.target.value);
          }}
          placeholder="e.g. api"
          aria-label="Team name"
          autoFocus
        />

        {/* THE TEAM — a roster of roles, which is what a team IS. The role
            leads each row because it is the address teammates use and the
            column that has to be scanned for duplicates; who fills it comes
            second. */}
        <span className="form__label">{shapeLabel}</span>
        {roster.length === 0 ? (
          <p className="form__desc team__empty">
            Nobody yet — start an agent below.
          </p>
        ) : (
          <ul className="team__roster">
            {roster.map((row) => (
              <li
                key={row.key}
                className={`team__member${row.pane ? "" : " team__member--new"}`}
              >
                <div className="team__row">
                  {/* A role is picked, not typed. It is no longer just an
                      address: it carries what the member is FOR, and that
                      only exists for a role the catalog has. Typing one in
                      could only ever produce a member nothing can describe. */}
                  <Dropdown
                    className="team__row-role"
                    options={roleOptions}
                    value={roleIdOf(row.role)}
                    onChange={(next) => row.setRole(next)}
                    ariaLabel={`Role for ${row.label}`}
                  />
                  {/* The ADDRESS, beside the role and not instead of it. The
                      picker names what a member is for; only this tells two
                      implementers apart, and it is the string a teammate
                      types — hiding it would leave the person unable to read
                      their own roster. */}
                  <span className="team__row-address">{row.role}</span>
                  {!parseRoleAddress(row.role) && (
                    // A role deleted from the catalog under a live member:
                    // the address still works, but the charter behind it is
                    // gone, so its holder is briefed thinly. Picking a role
                    // is the fix, and this is what says so.
                    <span
                      className="team__row-note"
                      title="This role is no longer in the catalog — pick one to give the member a charter again"
                    >
                      not in the catalog
                    </span>
                  )}
                  {row.pane ? (
                    <>
                      <AgentGlyph icon={iconOf(row.pane)} />
                      <span className="team__row-who">{row.label}</span>
                      <span className="team__row-where">{whereOf(workspace, row.pane)}</span>
                      {activity && (
                        <RowActivity source={activity} paneId={row.pane.id} />
                      )}
                    </>
                  ) : (
                    <>
                      {/* The app's own dropdown, never a native <select>: a
                          system popup is foreign chrome in a window that
                          renders every other interaction itself. */}
                      <Dropdown
                        className="team__row-agent"
                        options={canRecruit.map((agent) => ({
                          value: agent.id,
                          label: agent.label,
                        }))}
                        value={row.agentType}
                        onChange={row.setAgentType}
                        ariaLabel="Agent to start"
                      />
                      <span className="team__row-where">new</span>
                      {/* Asked per row, explained ONCE below. A lead reading
                          diffs and an implementer grinding through a
                          refactor want different answers, so the question
                          belongs in every row — but its two-line rationale
                          repeated six times turns a roster into a wall of
                          warnings. Gated on the agent's own declaration,
                          the same check every spawn surface applies. */}
                      {agentSupportsYolo(agents, row.agentType) && (
                        <label
                          className={`team__row-yolo${
                            row.yolo ? " team__row-yolo--on" : ""
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={row.yolo}
                            onChange={(e) => row.setYolo(e.target.checked)}
                          />
                          YOLO
                        </label>
                      )}
                    </>
                  )}
                  {/* The role's briefing, ON DEMAND — beside the row's other
                      meta control, not between the address and the member
                      it names: the left half of a row is identity, the
                      right edge is what can be done to it. */}
                  <button
                    type="button"
                    className="team__row-info"
                    aria-label={`What "${row.role}" will be told`}
                    title="What this member will be told"
                    onClick={() => setBriefFor(row.key)}
                  >
                    ⓘ
                  </button>
                  {row.remove && (
                    <button
                      type="button"
                      className="team__row-drop"
                      aria-label={`Do not start ${row.label}`}
                      title="Do not start this agent"
                      onClick={row.remove}
                    >
                      ×
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {roster.some((row) => !row.pane) && (
          // Said once for the column, not once per row: the rationale is
          // the same for every agent, and repeating it turned the roster
          // into a wall of warnings.
          <p className="form__desc team__desc team__yolo-note">
            <span className="team__yolo-word">YOLO</span> runs an agent without
            its permission prompts — it acts on its own.
          </p>
        )}

        {canRecruit.length > 0 && (
          // The one way of adding a member: an agent started ON the team,
          // in its directory. Still styled secondary — starting an agent is
          // a step on the way to a roster, never the thing that settles one.
          <button
            type="button"
            className="team__add"
            onClick={() => {
              setTouched(true);
              setRecruits((current) => [
                ...current,
                {
                  agentType: canRecruit[0].id,
                  role: suggestAddress(heldAddresses(current)),
                  // Seeded from the global preference, like every other
                  // spawn surface, and changeable per row from there.
                  yolo: defaultYolo,
                },
              ]);
            }}
          >
            + Start a new agent
          </button>
        )}

        {touched && !planned.ok && (
          // Its own style, not the git hint's: that one is green, and a
          // refusal rendered in the colour of a positive result is read as
          // one. Directly above the actions, where the disabled button that
          // it explains actually is.
          <p className="form__error team__error" role="alert">
            ⚠ {planned.message}
          </p>
        )}

        <div className="form__actions">
          <button type="button" className="form__cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="form__create" disabled={!valid}>
            Save team
          </button>
        </div>
      </form>
      {briefRow && (
        // The briefing ON DEMAND, over the dialog — the app's own stacked
        // notice, the same machinery every other dialog stacks. Verbatim
        // from the same teamBriefing the deck will say, off the draft as
        // it stands: a précis would be a second briefing to keep true.
        <ConfirmDialog
          title={`${parseRoleAddress(briefRow.role)?.role.label ?? briefRow.role} — ${briefRow.role}`}
          message={teamBriefing(
            name.trim() || team.name,
            briefRow.role,
            roster.map((row) => row.role),
          )}
          confirmLabel="OK"
          onConfirm={() => setBriefFor(null)}
        />
      )}
    </ModalOverlay>
  );
}
