import { useMemo, useState } from "react";
import {
  agentSupportsNew,
  agentSupportsYolo,
  selectableAgents,
  type AgentInfo,
} from "../../domain/agents";
import type { Pane, Workspace } from "../../domain/deck";
import { baseName, paneAgentType, paneDisplayTitle } from "../../domain/deck";
import {
  defaultRoleFor,
  mintRoleAddress,
  parseRoleAddress,
  planTeam,
  roleById,
  teamPlanIsEmpty,
  teamRoles,
  type TeamPlan,
  type TeamRecruitDraft,
} from "../../domain/mail";
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
  onConfirm(plan: TeamPlan): void;
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
  if (pane.branch) return pane.branch;
  return pane.cwd ? baseName(pane.cwd) : "";
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
  onConfirm,
  onCancel,
}: TeamDialogProps) {
  const [name, setName] = useState(editing ?? "");
  const startingMembers = useMemo(() => {
    const seeded = new Map<string, string>();
    if (editing) {
      for (const pane of workspace.panes) {
        if (pane.team?.name.toLowerCase() === editing.toLowerCase()) {
          seeded.set(pane.id, pane.team.role);
        }
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
  // Escape closes it, like every other dialog here. Nothing has happened
  // yet when it does: the whole point of settling a team as one plan is
  // that leaving mid-edit changes nothing.
  useEscape(onCancel);

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

  const draft = {
    name,
    members: [...roles].map(([paneId, role]) => ({ paneId, role })),
    recruits,
  };
  // `editing` matters beyond seeding the form: who has LEFT is a question
  // about the team as it stands, so a rename must not make the members it
  // dropped invisible.
  const planned = planTeam(workspace, draft, editing);
  // Nothing to do is not an error, but it is not a confirmable form either:
  // a dialog that dispatches a no-op teaches people it did something.
  const valid = planned.ok && !teamPlanIsEmpty(planned.value);

  /** Every address the roster holds, apart from one row's own — what a fresh
   * address has to avoid. */
  const addressesBesides = (mine: string): string[] =>
    [...roles.values(), ...recruits.map((recruit) => recruit.role)].filter(
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
          suggestAddress([...next.values(), ...recruits.map((r) => r.role)]),
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
    ...[...roles].map(([paneId, role]) => {
      const pane = workspace.panes.find((candidate) => candidate.id === paneId);
      return {
        key: paneId,
        role,
        pane: pane ?? null,
        label: pane ? titleOf(pane) : paneId,
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

  /** Everyone holding the edited team's name RIGHT NOW — what disbanding
   * has to release, read from the deck rather than from the draft, because
   * the draft may already have dropped some of them. */
  const current = editing
    ? workspace.panes
        .filter((pane) => pane.team?.name.toLowerCase() === editing.toLowerCase())
        .map((pane) => pane.id)
    : [];

  /** Everyone in the workspace who is NOT on the team. */
  const available = workspace.panes
    .filter((pane) => !roles.has(pane.id))
    .map((pane) => ({ pane, label: titleOf(pane) }));

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
            second. Rows stay in the order they were added, so the first one
            is the lead and reads like one. */}
        <span className="form__label">The team</span>
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
                  {row.pane ? (
                    <>
                      <AgentGlyph icon={iconOf(row.pane)} />
                      <span className="team__row-who">{row.label}</span>
                      <span className="team__row-where">{whereOf(row.pane)}</span>
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
                    ...roles.values(),
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
              {available.map(({ pane, label }) => {
                // A pane holds ONE team, so taking one that already has a
                // team would not add it — it would silently pull it out of
                // the other, whose remaining members are still briefed to
                // address a role that then reaches nobody, and who are told
                // nothing because "who left" is asked only of the team being
                // edited. Shown with where it is and no way to take it: the
                // agent has not vanished, it is simply spoken for.
                const spokenFor =
                  pane.team &&
                  pane.team.name.toLowerCase() !== name.trim().toLowerCase()
                    ? pane.team.name
                    : null;
                return (
                  <li key={pane.id} className="team__row">
                    <AgentGlyph icon={iconOf(pane)} />
                    <span className="team__row-who">{label}</span>
                    <span className="team__row-where">{whereOf(pane)}</span>
                    {spokenFor ? (
                      <span
                        className="team__row-note"
                        title={`Already on “${spokenFor}” — open that team from this agent's badge to take it off first`}
                      >
                        on “{spokenFor}”
                      </span>
                    ) : (
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
                    )}
                  </li>
                );
              })}
            </ul>
          </>
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
          {editing && (
            // Disbanding was possible before this — take everyone off the
            // roster and confirm — but only as a side effect of emptying a
            // list, which is not a thing anyone would think to try. Ending
            // a team is a deliberate act and deserves to be sayable.
            //
            // By default it takes the roles away and NOTHING else: the
            // agents keep running, keep their panes and keep their work.
            // Ending them is the other thing people actually want here —
            // the team is over, so are its agents — and closing four panes
            // by hand afterwards is busywork. So it is offered, but it is
            // ASKED FOR: the tick arms it, and the button then says what it
            // will do, because a destructive act must never be reachable by
            // the same click as an organisational one.
            <>
              <label
                className={`team__disband-close${
                  closeOnDisband ? " team__disband-close--on" : ""
                }`}
                title="End the agents too, keeping their worktrees — deleting one of those is its own decision"
              >
                <input
                  type="checkbox"
                  checked={closeOnDisband}
                  onChange={(e) => setCloseOnDisband(e.target.checked)}
                />
                close the agents too
              </label>
              <button
                type="button"
                className="team__disband"
                title={
                  closeOnDisband
                    ? `Take every agent off “${editing}” and close it`
                    : `Take every agent off “${editing}” — they keep running`
                }
                onClick={() =>
                  onConfirm({
                    name: editing,
                    members: [],
                    released: current,
                    closing: closeOnDisband ? current : [],
                    recruits: [],
                  })
                }
              >
                {closeOnDisband ? "Disband & close" : "Disband"}
              </button>
            </>
          )}
          <button type="button" className="form__cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="form__create" disabled={!valid}>
            {editing ? "Save team" : "Create team"}
          </button>
        </div>
      </form>
    </ModalOverlay>
  );
}
