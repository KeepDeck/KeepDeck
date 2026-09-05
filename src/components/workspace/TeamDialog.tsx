import { useMemo, useState, useSyncExternalStore } from "react";
import {
  agentSupportsNew,
  agentSupportsYolo,
  selectableAgents,
  type AgentInfo,
} from "../../domain/agents";
import type { Pane, Workspace } from "../../domain/deck";
import {
  attachedWorktree,
  baseName,
  paneAgentType,
  paneBranch,
  paneDisplayTitle,
} from "../../domain/deck";
import {
  defaultRoleFor,
  mintRoleAddress,
  paneIsOnTeam,
  parseRoleAddress,
  planDisband,
  planTeam,
  teamMembers,
  teamNameKey,
  teamNamesIn,
  roleById,
  teamBriefing,
  teamPlanIsEmpty,
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
  /** The team to edit, or null to start a new one. Editing an existing team
   * opens with its members already on the roster and their roles filled. */
  editing: string | null;
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
  /** Apply a settled roster. `closing` names the panes to END as well as
   * release — only the disband gesture asks for that, and only when the
   * person ticked it in the same breath, which is why it travels beside the
   * plan instead of inside it. */
  onConfirm(plan: TeamPlan, closing?: readonly string[]): void;
  onCancel(): void;
}

/** The address a row gets when nobody has picked one. WHICH role that is, and
 * the numbering, both belong to the catalog — this only says what the roster
 * already holds. A duplicate can only come back for a singleton already
 * taken, and `planTeam` says so in words the person can act on. */
function suggestAddress(taken: readonly string[]): string {
  const role = defaultRoleFor(taken);
  return mintRoleAddress(role, taken) ?? role.id;
}

/** What tells one pane from another when their titles do not. The branch
 * first — that is what an agent is actually working on — else the folder it
 * runs in. Empty when the pane has neither and the title is all there is. */
function whereOf(pane: Pane): string {
  const branch = paneBranch(pane);
  if (branch) return branch;
  const worktree = attachedWorktree(pane);
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
 * The whole team in one place: its name, who is on it, what each is called,
 * and any agents to start alongside them.
 *
 * A team is a workspace-level structure, so it is settled at that level
 * rather than a pane at a time. Editing membership one pane at a time can
 * never answer the question that decides whether a team WORKS — "are these
 * roles unique?" — because it never sees the whole roster; two panes can
 * each take `impl-1` a second apart and nothing is there to notice.
 *
 * The dialog decides nothing itself. It collects a draft and hands it to
 * `planTeam`, which settles it or says what is wrong — including who is
 * being taken OFF the team, which the caller must not have to work out
 * again.
 */
export function TeamDialog({
  workspace,
  agents,
  editing,
  defaultYolo,
  activity,
  onConfirm,
  onCancel,
}: TeamDialogProps) {
  const [name, setName] = useState(editing ?? "");
  const startingMembers = useMemo(() => {
    const seeded = new Map<string, string>();
    if (editing) {
      for (const pane of teamMembers(workspace, editing)) {
        seeded.set(pane.id, pane.team!.role);
      }
    }
    return seeded;
  }, [editing, workspace.panes]);
  /** Ticked panes and the role each is to hold. A pane absent from the map
   * is simply not on the team. */
  const [roles, setRoles] = useState<Map<string, string>>(startingMembers);
  const [recruits, setRecruits] = useState<TeamRecruitDraft[]>([]);
  /** Whether the person has done anything yet. A form that greets you with
   * "the team needs a name" is scolding you for not having typed — the
   * complaint is only true, and only useful, once something was attempted. */
  const [touched, setTouched] = useState(false);
  /** Whether disbanding should also end the agents. Off every time the
   * dialog opens: the destructive reading of a control has to be chosen
   * again each time, never inherited from the last team somebody ended. */
  const [closeOnDisband, setCloseOnDisband] = useState(false);
  /** The roster row whose briefing is open in a notice over this dialog —
   * null when none is. */
  const [briefFor, setBriefFor] = useState<string | null>(null);
  /** Whether the disband confirm is up. Ending a team is not an edit, so
   * the question is asked in its own dialog, not by a control in the
   * footer. */
  const [disbanding, setDisbanding] = useState(false);

  const canRecruit = useMemo(
    () => selectableAgents(agents).filter((agent) => agentSupportsNew(agents, agent.id)),
    [agents],
  );
  /** The catalog, as the picker takes it. Roles are chosen, never typed —
   * a role now carries what a member is FOR, and that only exists for one
   * the catalog has. */
  const roleOptions = useMemo(
    () => teamRoles().map((role) => ({ value: role.id, label: role.label })),
    [],
  );
  /** The catalog id behind a stored address, which is what the picker shows.
   * Empty for an address the catalog cannot account for — `planTeam` refuses
   * it, and an empty picker is the honest rendering of "no role yet". */
  const roleIdOf = (address: string) => parseRoleAddress(address)?.role.id ?? "";

  // Entries whose pane left the WORKSPACE while the dialog was open (an
  // agent closed over MCP) are dropped from the draft and the roster both.
  // Carried with `pane: null`, they wore the recruit branch — a dashed
  // card with a dead agent picker, claiming an agent was about to start.
  const liveRoles = [...roles].filter(([paneId]) =>
    workspace.panes.some((candidate) => candidate.id === paneId),
  );
  const draft = {
    name,
    members: liveRoles.map(([paneId, role]) => ({ paneId, role })),
    recruits,
  };
  // `editing` matters beyond seeding the form: who has LEFT is a question
  // about the team as it stands, so a rename must not make the members it
  // dropped invisible.
  const planned = planTeam(workspace, draft, editing);
  // "+ Team" is ALWAYS a new team, and a rename must stay a rename: a name
  // some OTHER team holds would not create or rename anything. planTeam
  // would settle it as an edit of that team (create), or silently MERGE
  // two teams into one name with duplicate addresses (rename) — either
  // way, members evicted or mail misdelivered with nobody re-briefed. So
  // it is refused in words instead.
  const nameTaken = teamNamesIn(workspace).some(
    (existing) =>
      teamNameKey(existing) === teamNameKey(name) &&
      (editing === null || teamNameKey(existing) !== teamNameKey(editing)),
  );
  // Nothing to do is not an error, but it is not a confirmable form either:
  // a dialog that dispatches a no-op teaches people it did something.
  const valid = planned.ok && !teamPlanIsEmpty(planned.value) && !nameTaken;

  /** Whether a roles-map entry still names a pane the workspace holds. */
  const paneLives = (paneId: string) =>
    workspace.panes.some((candidate) => candidate.id === paneId);

  /** The live entries' addresses out of a roles map. Dead panes' entries
   * are dropped from the roster and the draft, so a ghost must not keep
   * its address "taken" for the minting paths either. */
  const liveRoleValues = (held: ReadonlyMap<string, string>): string[] =>
    [...held].filter(([paneId]) => paneLives(paneId)).map(([, role]) => role);

  /** Every address the roster holds, apart from one row's own — what a fresh
   * address has to avoid. */
  const addressesBesides = (mine: string): string[] =>
    [...liveRoleValues(roles), ...recruits.map((recruit) => recruit.role)].filter(
      (address) => address !== mine,
    );

  /** The address for a chosen ROLE. The picker answers with a catalog id; the
   * roster stores an address, because two implementers need telling apart.
   * A singleton already held comes back as itself, and the duplicate is
   * refused in words rather than swallowed by a click that does nothing. */
  const addressFor = (roleId: string, mine: string): string => {
    const role = roleById(roleId);
    if (!role) return mine;
    return mintRoleAddress(role, addressesBesides(mine)) ?? role.id;
  };

  const take = (pane: Pane) =>
    setRoles((current) => {
      const next = new Map(current);
      // Its EXISTING role when it has one — re-adding a member of the team
      // being edited must not silently rename it — else the next suggestion.
      next.set(
        pane.id,
        pane.team?.role ??
          suggestAddress([
            ...liveRoleValues(next),
            ...recruits.map((r) => r.role),
          ]),
      );
      return next;
    });

  const drop = (paneId: string) =>
    setRoles((current) => {
      const next = new Map(current);
      next.delete(paneId);
      return next;
    });

  const setRole = (paneId: string, roleId: string) =>
    setRoles((current) =>
      new Map(current).set(paneId, addressFor(roleId, current.get(paneId) ?? "")),
    );

  const iconOf = (pane: Pane) =>
    agents.find((agent) => agent.id === paneAgentType(pane))?.icon;

  const titleOf = (pane: Pane) =>
    paneDisplayTitle(pane, workspace.panes.indexOf(pane), agents);

  /** The team as it currently stands: taken panes first, in the order they
   * were taken, then the agents to start. One list, because to the person
   * reading it they are all members — the difference is only that some do
   * not exist yet. */
  const roster = [
    ...liveRoles.map(([paneId, role]) => {
      const pane = workspace.panes.find((candidate) => candidate.id === paneId)!;
      return {
        key: paneId,
        role,
        pane: pane as Pane | null,
        label: titleOf(pane),
        agentType: "",
        yolo: false,
        setRole: (next: string) => setRole(paneId, next),
        setAgentType: () => {},
        setYolo: () => {},
        remove: () => drop(paneId),
      };
    }),
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
      remove: () =>
        setRecruits((current) => current.filter((_, i) => i !== index)),
    })),
  ];

  /** Everyone in the workspace who is NOT on the team. */
  const available = workspace.panes
    .filter((pane) => !roles.has(pane.id))
    .map((pane) => ({ pane, label: titleOf(pane) }));

  // A pane holds ONE team, so a pooled pane that already has a different
  // one cannot be taken — it would be pulled out of a team whose remaining
  // members are still briefed to address its role. Membership is compared
  // against the team being EDITED, never the name box: typing renames the
  // team, and compared to the box every own member read as another team's
  // from a rename's first keystroke.
  //
  // The takeable lead the pool; the spoken-for sink below it, folded to a
  // line per TEAM — a row each repeated one fact as many times as that
  // team has members, and pushed the panes that can actually be added out
  // of first sight.
  const currentTeam = editing ?? name;
  const takeable = available.filter(
    ({ pane }) => !pane.team || paneIsOnTeam(pane, currentTeam),
  );
  const spokenFor: { team: string; members: typeof available }[] = [];
  for (const entry of available) {
    if (!entry.pane.team || paneIsOnTeam(entry.pane, currentTeam)) continue;
    const team = entry.pane.team.name;
    const group = spokenFor.find(
      (candidate) => teamNameKey(candidate.team) === teamNameKey(team),
    );
    if (group) group.members.push(entry);
    else spokenFor.push({ team, members: [entry] });
  }

  // The row whose briefing the notice quotes — re-found per render, so the
  // words stay live while the roster is edited under it, and a dropped row
  // simply closes it.
  const briefRow = roster.find((row) => row.key === briefFor) ?? null;

  // Escape closes the dialog, like every other one here — nothing has
  // happened yet, since settling a team as one plan is what makes leaving
  // mid-edit free. While anything is STACKED over it, Escape is the top
  // surface's to claim, and the guard reads the same value the notice
  // renders from (briefRow, never the raw key) — so a stale key can never
  // leave the dialog deaf with nothing on screen.
  useEscape(onCancel, briefRow === null && !disbanding);

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

  return (
    <ModalOverlay>
      <form
        className="form team-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (planned.ok && valid) onConfirm(planned.value);
        }}
      >
        <h2 className="form__title">{editing ? "Edit team" : "New team"}</h2>
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
          // "e.g." on purpose: a bare "api" reads as a value already in the
          // field, which is exactly how an empty form comes to look filled
          // in while complaining that it is empty.
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
            Nobody yet — take an agent from below, or start a new one.
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
                      <span className="team__row-where">{whereOf(row.pane)}</span>
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
                          warnings, which is what the shared field did here.
                          The header carries the meaning, the cells carry the
                          answers. Gated on the agent's own declaration, the
                          same check every spawn surface applies. */}
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
                      meta control (×), not between the address and the
                      member it names: the left half of a row is identity,
                      the right edge is what can be done to it. Assembling a
                      team is frequent and reading a charter is rare, so the
                      words sit behind this ask rather than in a panel. */}
                  <button
                    type="button"
                    className="team__row-info"
                    aria-label={`What "${row.role}" will be told`}
                    title="What this member will be told"
                    onClick={() => setBriefFor(row.key)}
                  >
                    ⓘ
                  </button>
                  <button
                    type="button"
                    className="team__row-drop"
                    aria-label={`Take ${row.label} off the team`}
                    title="Take off the team"
                    onClick={row.remove}
                  >
                    ×
                  </button>
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
          // Above the pool, because it is the one way of adding a member
          // that ALWAYS works. The pool can be entirely unusable — every
          // agent in the workspace already spoken for by another team — and
          // then this button was the only live control on the form, sitting
          // under a list of rows that offer nothing. Still styled secondary:
          // starting an agent is a step ON THE WAY to a team, never the
          // thing that finishes one.
          <button
            type="button"
            className="team__add"
            onClick={() => {
              setTouched(true);
              setRecruits((current) => [
                ...current,
                {
                  agentType: canRecruit[0].id,
                  role: suggestAddress([
                    ...liveRoleValues(roles),
                    ...current.map((row) => row.role),
                  ]),
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

        {/* THE POOL — only what is NOT on the team. A pane that has been
            taken leaves this list, so the two together always read as one
            answer to "who is where" instead of a field of checkboxes that
            has to be decoded. */}
        {available.length > 0 && (
          <>
            <span className="form__label">Also running here</span>
            <ul className="team__pool">
              {takeable.map(({ pane, label }) => (
                <li key={pane.id} className="team__row">
                  <AgentGlyph icon={iconOf(pane)} />
                  <span className="team__row-who">{label}</span>
                  <span className="team__row-where">{whereOf(pane)}</span>
                  {activity && <RowActivity source={activity} paneId={pane.id} />}
                  <button
                    type="button"
                    className="team__row-take"
                    onClick={() => {
                      setTouched(true);
                      take(pane);
                    }}
                  >
                    Add
                  </button>
                </li>
              ))}
              {/* Shown, not hidden: these agents have not vanished, they
                  are spoken for — and saying so once per TEAM answers it,
                  with the word "Team" naming what the quotes hold. One
                  compact card per team: a head with the name and the
                  count, then the members in a dense grid whose cells
                  truncate — a large team grows in rows of a grid, never
                  into a ragged inline paragraph. */}
              {spokenFor.map((group) => (
                <li
                  key={group.team}
                  className="team__pool-team"
                  title={`Already on “${group.team}” — open that team from an agent's badge to take one off first`}
                >
                  <div className="team__pool-team-head">
                    <span className="team__pool-team-name">
                      Team “{group.team}”
                    </span>
                    <span className="team__pool-team-count">
                      {group.members.length}{" "}
                      {group.members.length === 1 ? "agent" : "agents"}
                    </span>
                  </div>
                  <div className="team__pool-team-grid">
                    {group.members.map(({ pane, label }) => (
                      <span
                        key={pane.id}
                        className="team__pool-member"
                        title={label}
                      >
                        <AgentGlyph icon={iconOf(pane)} />
                        <span className="team__pool-member-name">{label}</span>
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}

        {touched && (nameTaken || !planned.ok) && (
          // Its own style, not the git hint's: that one is green, and a
          // refusal rendered in the colour of a positive result is read as
          // one. Directly above the actions, where the disabled button that
          // it explains actually is.
          <p className="form__error team__error" role="alert">
            ⚠{" "}
            {nameTaken
              ? `a team called “${name.trim()}” already exists — open it from an agent's badge to edit it`
              : planned.ok
                ? ""
                : planned.message}
          </p>
        )}

        <div className="form__actions">
          {editing && (
            // Disbanding was possible before this — take everyone off the
            // roster and confirm — but only as a side effect of emptying a
            // list, which is not a thing anyone would think to try. Ending
            // a team is a deliberate act and deserves to be sayable.
            <button
              // Ending the team is not an edit, so it is not one of the
              // form's verdict buttons: one quiet door at the far left,
              // and the decision itself happens in the app's destructive
              // confirm — its own words, its own moment, its own Escape.
              type="button"
              className="team__end"
              onClick={() => {
                // The destructive reading is chosen again each time the
                // question is asked, never inherited from the last team
                // somebody ended.
                setCloseOnDisband(false);
                setDisbanding(true);
              }}
            >
              Disband team
            </button>
          )}
          <button type="button" className="form__cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="form__create" disabled={!valid}>
            {editing ? "Save team" : "Create team"}
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
            name.trim() || "…",
            briefRow.role,
            roster.map((row) => row.role),
          )}
          confirmLabel="OK"
          onConfirm={() => setBriefFor(null)}
        />
      )}
      {disbanding && editing && (
        // The destructive act gets the destructive dialog: Cancel holds
        // focus so Enter cannot disband, and the tick that ends the agents
        // too is read HERE, beside the button it changes. By default the
        // roles come off and nothing else.
        <ConfirmDialog
          title={`Disband “${editing}”?`}
          message={`Every agent comes off “${editing}” and its roles stop reaching anyone. Unless you also close them below, the agents keep running and keep their work.`}
          confirmLabel="Disband"
          cancelLabel="Cancel"
          destructive
          onConfirm={() => {
            // Through the domain, like every other change to a team. This
            // gesture used to build its plan by hand, which made the
            // destructive path the one path that passed no check.
            const disband = planDisband(workspace, editing);
            if (!disband.ok) {
              // The team can vanish under an open dialog (an agent-driven
              // disband over MCP). A dead red button is the one thing this
              // confirm must not be — closing it says the moment passed.
              setDisbanding(false);
              return;
            }
            setDisbanding(false);
            onConfirm(disband.value, closeOnDisband ? disband.value.released : []);
          }}
          onCancel={() => setDisbanding(false)}
        >
          <label
            className={`team__disband-close${
              closeOnDisband ? " team__disband-close--on" : ""
            }`}
            title="Keeps their worktrees — deleting one of those is its own decision"
          >
            <input
              type="checkbox"
              checked={closeOnDisband}
              onChange={(e) => setCloseOnDisband(e.target.checked)}
            />
            {/* The app draws its own box — the OS control is the one
                element no stylesheet reaches, and it showed. */}
            <span className="team__disband-box" aria-hidden="true">
              ✓
            </span>
            close the agents too
          </label>
        </ConfirmDialog>
      )}
    </ModalOverlay>
  );
}
