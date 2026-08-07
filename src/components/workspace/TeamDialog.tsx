import { useMemo, useState } from "react";
import {
  agentSupportsNew,
  selectableAgents,
  type AgentInfo,
  type AgentType,
} from "../../domain/agents";
import type { Pane, Workspace } from "../../domain/deck";
import { baseName, paneAgentType, paneDisplayTitle } from "../../domain/deck";
import {
  LEAD_ROLE,
  planTeam,
  teamPlanIsEmpty,
  type TeamPlan,
} from "../../domain/mail";
import { ModalOverlay } from "../../ui/ModalOverlay";
import { AgentGlyph } from "../../ui/AgentGlyph";
import { noAutoCorrect } from "../../ui/inputProps";

interface TeamDialogProps {
  workspace: Workspace;
  agents: AgentInfo[];
  /** The team to edit, or null to start a new one. Editing an existing team
   * opens with its members already ticked and their roles filled. */
  editing: string | null;
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
  const [recruits, setRecruits] = useState<{ agentType: AgentType; role: string }[]>(
    [],
  );
  /** Whether the person has done anything yet. A form that greets you with
   * "the team needs a name" is scolding you for not having typed — the
   * complaint is only true, and only useful, once something was attempted. */
  const [touched, setTouched] = useState(false);

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

  const toggle = (pane: Pane) => {
    setRoles((current) => {
      const next = new Map(current);
      if (next.has(pane.id)) next.delete(pane.id);
      // Its EXISTING role when it has one — re-ticking a member of the team
      // being edited must not silently rename it — else the next suggestion.
      else next.set(pane.id, pane.team?.role ?? suggestRole(next.size));
      return next;
    });
  };

  const setRole = (paneId: string, role: string) =>
    setRoles((current) => new Map(current).set(paneId, role));

  return (
    <ModalOverlay>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (planned.ok && valid) onConfirm(planned.value);
        }}
      >
        <h2 className="form__title">{editing ? "Edit team" : "New team"}</h2>
        <p className="form__desc">
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

        <span className="form__label">Who is on the team</span>
        {workspace.panes.length === 0 ? (
          <p className="form__desc">
            No agents here yet — add one below and it starts on the team.
          </p>
        ) : (
          <ul className="team__members">
            {workspace.panes.map((pane, index) => {
              const on = roles.has(pane.id);
              const elsewhere =
                pane.team && pane.team.name.toLowerCase() !== name.trim().toLowerCase()
                  ? pane.team.name
                  : null;
              return (
                <li key={pane.id} className="team__member">
                  <label className="team__member-pick">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => {
                        setTouched(true);
                        toggle(pane);
                      }}
                    />
                    <AgentGlyph
                      icon={
                        agents.find((agent) => agent.id === paneAgentType(pane))?.icon
                      }
                    />
                    <span className="team__member-name">
                      {paneDisplayTitle(pane, index, agents)}
                    </span>
                    {/* Titles come from the terminal, so several panes
                        legitimately read "Workspace" at once — the roster is
                        where you pick WHICH agent, so a row that cannot be
                        told from its neighbour is a row that cannot be used.
                        The branch, else the folder, is what differs. */}
                    <span className="team__member-where">{whereOf(pane)}</span>
                  </label>
                  {on ? (
                    <input
                      {...noAutoCorrect}
                      className="form__input team__member-role"
                      value={roles.get(pane.id) ?? ""}
                      onChange={(e) => setRole(pane.id, e.target.value)}
                      placeholder="role"
                      aria-label={`Role for ${paneDisplayTitle(pane, index, agents)}`}
                    />
                  ) : (
                    // Said only while the pane is NOT being taken: once it is
                    // ticked, the plan already moves it and the warning would
                    // be describing a state the person just changed.
                    elsewhere && (
                      <span className="team__member-note">on “{elsewhere}”</span>
                    )
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <span className="form__label">Add new agents</span>
        <ul className="team__members">
          {recruits.map((recruit, index) => (
            <li key={index} className="team__member">
              <select
                className="form__input team__member-agent"
                value={recruit.agentType}
                aria-label="Agent to start"
                onChange={(e) =>
                  setRecruits((current) =>
                    current.map((row, i) =>
                      i === index ? { ...row, agentType: e.target.value } : row,
                    ),
                  )
                }
              >
                {canRecruit.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.label}
                  </option>
                ))}
              </select>
              <input
                {...noAutoCorrect}
                className="form__input team__member-role"
                value={recruit.role}
                onChange={(e) =>
                  setRecruits((current) =>
                    current.map((row, i) =>
                      i === index ? { ...row, role: e.target.value } : row,
                    ),
                  )
                }
                placeholder="role"
                aria-label="Role for the new agent"
              />
              <button
                type="button"
                className="form__field-btn"
                aria-label="Remove this new agent"
                onClick={() =>
                  setRecruits((current) => current.filter((_, i) => i !== index))
                }
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        {canRecruit.length > 0 && (
          // Deliberately small and secondary: full width it read as the
          // dialog's main action and competed with "Create team", which is
          // the one button that finishes anything here.
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
                },
              ]);
            }}
          >
            + Agent
          </button>
        )}

        {touched && !planned.ok && (
          // Its own style, not the git hint's: that one is green, and a
          // refusal rendered in the colour of a positive result is read as
          // one. Directly above the actions, where the disabled button that
          // it explains actually is.
          <p className="form__error" role="alert">
            ⚠ {planned.message}
          </p>
        )}

        <div className="form__actions">
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
