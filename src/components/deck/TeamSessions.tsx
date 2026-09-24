import { useMemo, useState } from "react";
import type { AgentInfo } from "../../domain/agents";
import type { JournalRecords, SessionHandle } from "../../domain/journal";
import { teamJournalLanes, type Workspace } from "../../domain/deck";
import type { BrowserSharedSeam } from "../../app/useSessionsBrowser";
import { NO_ROLE, ROLE_WORDS, roleChoiceView } from "../../presentation/roleChoiceView";
import { TEAM_SESSIONS_WORDS, teamSessionsHint } from "../../presentation/stageView";
import { Dropdown } from "../../ui/Dropdown";
import { useRoleCatalog } from "../../app/useRoleCatalog";
import { WorkspaceSessionsBrowser } from "../history/SessionsBrowser";

interface TeamSessionsProps {
  ws: Workspace;
  /** The team's directory: its sessions pin first, and only they resume. */
  cwd: string;
  journal: JournalRecords;
  browserShared: BrowserSharedSeam;
  agents: AgentInfo[];
  agentsReady: boolean;
  /** Continue `record` onto the team under `role` — resumed, or forked into
   * the team's directory. */
  onContinue(mode: "resume" | "fork", record: SessionHandle, role: string): void;
}

/**
 * An open team with nobody on it: the sessions it can continue, from every
 * directory, and the role the first member takes. A team with nobody on it
 * takes a lead or a peer, and neither is picked for the person — Resume and
 * Fork wait for the pick.
 */
export function TeamSessions({
  ws,
  cwd,
  journal,
  browserShared,
  agents,
  agentsReady,
  onContinue,
}: TeamSessionsProps) {
  const [picked, setPicked] = useState(NO_ROLE);
  const [askedWithout, setAskedWithout] = useState(false);
  // Nobody on the team: the roster is empty by the stage's own answer. The
  // catalog is live — the role editor can add or drop a role while the
  // list is open — so the choice is rebuilt with it, and a pick it lost
  // is no pick.
  const catalog = useRoleCatalog();
  const roles = useMemo(() => roleChoiceView([]), [catalog]);
  const roleId = roles.pickOf(picked);
  // A lost pick is discarded, not hidden: the role coming back later is
  // not somebody choosing it again.
  if (roleId !== picked) setPicked(roleId);
  const address = roles.addressFor(roleId);
  const hint = teamSessionsHint(address, askedWithout);
  // Identity-stable: the browser's engines key on these.
  const lanes = useMemo(() => teamJournalLanes(journal, ws.id, cwd), [journal, ws.id, cwd]);
  const dirs = useMemo(() => new Set([cwd]), [cwd]);
  const team = useMemo(() => ({ cwd }), [cwd]);
  const continueAs = (mode: "resume" | "fork") => (record: SessionHandle) => {
    if (address === null) {
      setAskedWithout(true);
      return;
    }
    onContinue(mode, record, address);
  };
  return (
    <div className="deck__setup">
      <div className="deck__setup-col">
        <div className="team-sessions__head">
          <h2 className="history__title team-sessions__title">{TEAM_SESSIONS_WORDS.title}</h2>
          <div className="team-sessions__pick">
            <span className="form__label team-sessions__label">{ROLE_WORDS.label}</span>
            <Dropdown
              className="team-sessions__role"
              options={roles.optionsFor(roleId)}
              value={roleId}
              onChange={(next) => {
                setPicked(next);
                setAskedWithout(false);
              }}
              ariaLabel={ROLE_WORDS.label}
            />
            {hint?.kind === "address" && (
              <span className="team-sessions__hint">
                {ROLE_WORDS.writeTo} <code className="form__role-address">{hint.address}</code>
              </span>
            )}
            {hint?.kind === "error" && (
              <span className="team-sessions__hint team-sessions__hint--error">{hint.text}</span>
            )}
          </div>
        </div>
        <WorkspaceSessionsBrowser
          shared={browserShared}
          dirs={dirs}
          agents={agents}
          ready={agentsReady}
          rows={lanes.own}
          otherRecords={lanes.other}
          team={team}
          onResume={continueAs("resume")}
          onFork={continueAs("fork")}
        />
      </div>
    </div>
  );
}
