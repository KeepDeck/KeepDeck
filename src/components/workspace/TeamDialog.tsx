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
  LEAD_ROLE,
  planTeam,
  teamPlanIsEmpty,
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

/** A role suggestion for a row the person has not filled yet. The first row
 * gets `lead` because a team usually has one and it is the role every agent
 * knows to look for; the rest number themselves. */
function suggestRole(index: number): string {
  return index === 0 ? LEAD_ROLE : `impl-${index}`;
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
  // Escape closes it, like every other dialog here. Nothing has happened
  // yet when it does: the whole point of settling a team as one plan is
  // that leaving mid-edit changes nothing.
  useEscape(onCancel);

  const canRecruit = useMemo(
    () => selectableAgents(agents).filter((agent) => agentSupportsNew(agents, agent.id)),
    [agents],
  );

  const draft = {
    name,
    members: [...roles].map(([paneId, role]) => ({ paneId, role })),
    recruits,
  };
  const planned = planTeam(workspace, draft);
  // Nothing to do is not an error, but it is not a confirmable form either:
  // a dialog that dispatches a no-op teaches people it did something.
  const valid = planned.ok && !teamPlanIsEmpty(planned.value);

  const take = (pane: Pane) =>
    setRoles((current) => {
      const next = new Map(current);
      // Its EXISTING role when it has one — re-adding a member of the team
      // being edited must not silently rename it — else the next suggestion.
      next.set(pane.id, pane.team?.role ?? suggestRole(next.size + recruits.length));
      return next;
    });

  const drop = (paneId: string) =>
    setRoles((current) => {
      const next = new Map(current);
      next.delete(paneId);
      return next;
    });

  const setRole = (paneId: string, role: string) =>
    setRoles((current) => new Map(current).set(paneId, role));

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
          current.map((row, i) => (i === index ? { ...row, role: next } : row)),
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
              <li key={row.key} className="team__row">
                <input
                  {...noAutoCorrect}
                  className="form__input team__row-role"
                  value={row.role}
                  onChange={(e) => row.setRole(e.target.value)}
                  placeholder="role"
                  aria-label={`Role for ${row.label}`}
                />
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
                    {/* Per recruit, because a lead reading diffs and an
                        implementer grinding through a refactor want
                        different answers — one setting for the whole team
                        would make the safe choice the expensive one. Shown
                        only where the agent declares the mode, the same
                        gate every other spawn surface uses. */}
                    {agentSupportsYolo(agents, row.agentType) && (
                      <button
                        type="button"
                        className={`team__row-yolo${
                          row.yolo ? " team__row-yolo--on" : ""
                        }`}
                        aria-pressed={row.yolo}
                        title="YOLO mode — runs without permission prompts, the agent acts on its own"
                        onClick={() => row.setYolo(!row.yolo)}
                      >
                        YOLO
                      </button>
                    )}
                    <span className="team__row-where">starts when you confirm</span>
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
              </li>
            ))}
          </ul>
        )}

        {/* THE POOL — only what is NOT on the team. A pane that has been
            taken leaves this list, so the two together always read as one
            answer to "who is where" instead of a field of checkboxes that
            has to be decoded. */}
        {available.length > 0 && (
          <>
            <span className="form__label">Also running here</span>
            <ul className="team__pool">
              {available.map(({ pane, label }) => (
                <li key={pane.id} className="team__row">
                  <AgentGlyph icon={iconOf(pane)} />
                  <span className="team__row-who">{label}</span>
                  <span className="team__row-where">{whereOf(pane)}</span>
                  {pane.team &&
                    pane.team.name.toLowerCase() !== name.trim().toLowerCase() && (
                      <span className="team__row-note">on “{pane.team.name}”</span>
                    )}
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
            </ul>
          </>
        )}

        {canRecruit.length > 0 && (
          // Secondary by construction: starting an agent is a step ON THE
          // WAY to a team, never the thing that finishes one.
          <button
            type="button"
            className="team__add"
            onClick={() => {
              setTouched(true);
              setRecruits((current) => [
                ...current,
                {
                  agentType: canRecruit[0].id,
                  role: suggestRole(roles.size + current.length),
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
          {editing && (
            // Disbanding was possible before this — take everyone off the
            // roster and confirm — but only as a side effect of emptying a
            // list, which is not a thing anyone would think to try. Ending
            // a team is a deliberate act and deserves to be sayable.
            //
            // It takes the roles away and NOTHING else: the agents keep
            // running, keep their panes and keep their work. A control that
            // also closed them would be a destructive action wearing an
            // organisational label.
            <button
              type="button"
              className="team__disband"
              title={`Take every agent off “${editing}” — they keep running`}
              onClick={() =>
                onConfirm({ name: editing, members: [], released: current, recruits: [] })
              }
            >
              Disband
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
    </ModalOverlay>
  );
}
