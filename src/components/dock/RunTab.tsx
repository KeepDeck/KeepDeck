import { useRef, useState } from "react";
import {
  launchRun,
  removeDeadRunsFor,
  removeRun,
  restartRun,
  stopRun,
} from "../../app/runManager";
import { useRunSessions } from "../../app/useRunSessions";
import {
  addPreset,
  commandRows,
  removePreset,
  updatePreset,
  type RunSession,
} from "../../domain/run";
import { Dropdown } from "../../ui/Dropdown";
import { noAutoCorrect } from "../../ui/inputProps";
import {
  CloseIcon,
  EditIcon,
  PlayFillIcon,
  PlayIcon,
  StopFillIcon,
} from "../../ui/icons";
import { RunLog } from "./RunLog";
import type { DockTabProps } from "./tabs";

/**
 * The Run tab: one command — one row. Each row fuses a saved command with
 * its live state for the CURRENT target: the state glyph on the left doubles
 * as the control on hover (run / stop / run again), instances in other
 * targets indent as child rows, and re-running replaces a dead session
 * instead of piling a new one. The command form collapses behind the section
 * header's "+" (the workspaces-rail idiom) and opens above the list.
 * Everything here drives `runManager`; nothing touches the agent grid.
 */
export function RunTab({ ws, selectedPaneId, onSetRun }: DockTabProps) {
  // Where to run: a pane's worktree, or the workspace folder. Defaults to
  // the highlighted pane's worktree — "run what I'm looking at" — and
  // FOLLOWS the highlight (the pane-header ▶ selects, then reveals this
  // panel); a manual pick holds only until the next pane click. Same
  // seen-ref idiom as WorkspaceForm's default-agent follow.
  const [target, setTarget] = useState(
    () => ws.panes.find((p) => p.id === selectedPaneId)?.cwd ?? ws.cwd,
  );
  const seenSelectedRef = useRef(selectedPaneId);
  if (seenSelectedRef.current !== selectedPaneId) {
    seenSelectedRef.current = selectedPaneId;
    const followed = ws.panes.find((p) => p.id === selectedPaneId)?.cwd;
    if (followed && followed !== target) setTarget(followed);
  }
  const [command, setCommand] = useState("");
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  // The caption's ✕ hides the log; picking a row (or launching) re-opens it.
  const [logOpen, setLogOpen] = useState(true);
  // The command form is collapsed behind the header's "+" (`null`); open,
  // it either adds a new command (`presetId: null`) or — via a row's ✎ —
  // rewrites an existing one.
  const [draft, setDraft] = useState<{ presetId: string | null } | null>(null);

  const sessions = useRunSessions().filter((s) => s.wsId === ws.id);
  const rows = commandRows(ws.run?.presets ?? [], sessions, target);
  const shown = logOpen
    ? (sessions.find((s) => s.id === picked) ?? sessions[sessions.length - 1])
    : undefined;

  const pick = (id: string) => {
    setPicked(id);
    setLogOpen(true);
  };

  // Distinct run targets: each pane worktree once, the workspace folder last
  // (dropped from the pane pass so an attached-to-main pane can't duplicate it).
  const targets = [
    ...[
      ...new Map(
        ws.panes
          .filter((p) => p.cwd && p.cwd !== ws.cwd)
          .map((p) => [p.cwd!, p.branch ?? shortPath(p.cwd!)]),
      ).entries(),
    ].map(([value, label]) => ({ value, label })),
    { value: ws.cwd, label: "Workspace folder" },
  ];

  const targetLabel = (s: RunSession) =>
    s.worktree === ws.cwd
      ? "workspace folder"
      : (s.branch ?? shortPath(s.worktree));

  /** Launch a preset — in the current target, or a specific one (a child
   * row's re-run). Always sends the preset's CURRENT command: the manager's
   * replace-on-relaunch picks it up, so an edited command applies on the
   * next run instead of resurrecting the old snapshot. */
  const launchPreset = (
    preset: { id: string; name: string; command: string },
    where?: { worktree: string; branch?: string },
  ) => {
    const branch = ws.panes.find((p) => p.cwd === target)?.branch;
    void launchRun(
      ws.id,
      where ?? { worktree: target, ...(branch && { branch }) },
      { presetId: preset.id, command: preset.command, name: preset.name },
    ).then(pick);
  };

  const closeDraft = () => {
    setDraft(null);
    setCommand("");
    setName("");
  };

  const openAdd = () => {
    setCommand("");
    setName("");
    setDraft({ presetId: null });
  };

  const startEditing = (presetId: string) => {
    const preset = ws.run?.presets.find((p) => p.id === presetId);
    if (!preset) return;
    setCommand(preset.command);
    setName(preset.name);
    setDraft({ presetId });
  };

  /** Add / Save — store the draft as a command (rewrite when it came from a
   * row's ✎), never launching. Running is the row's job. */
  const saveDraft = () => {
    const line = command.trim();
    if (!line || !draft) return;
    onSetRun(
      draft.presetId && ws.run
        ? updatePreset(ws.run, draft.presetId, name, line)
        : addPreset(ws.run, name, line),
    );
    closeDraft();
  };

  /** The state glyph: rest face shows the state, hover face IS the control.
   * `rerun` overrides the dead-session action (preset rows relaunch with the
   * preset's current command); without it, the snapshot restarts (orphans —
   * their old command is all that's left of them). */
  const glyph = (
    s: RunSession | undefined,
    name: string,
    onIdleRun?: () => void,
    rerun?: () => void,
  ) => {
    const act = (title: string, run: () => void, icon: React.ReactNode) => (
      <button
        type="button"
        className="run__g-act"
        title={title}
        aria-label={`${title}: ${name}`}
        onClick={(e) => {
          e.stopPropagation();
          run();
        }}
      >
        {icon}
      </button>
    );
    if (!s) {
      return (
        <span className={`run__g${onIdleRun ? " run__g--actable" : ""}`}>
          <span className="run__g-rest run__g-idle">
            <PlayIcon />
          </span>
          {onIdleRun && act("Run", onIdleRun, <PlayFillIcon />)}
        </span>
      );
    }
    switch (s.status.kind) {
      case "running":
        return (
          <span className="run__g run__g--actable">
            <span className="run__g-rest run__dot run__dot--running" />
            {act("Stop", () => stopRun(s.id), <StopFillIcon />)}
          </span>
        );
      case "stopping":
        return (
          <span className="run__g">
            <span className="run__g-rest run__dot run__dot--stopping" />
          </span>
        );
      case "exited":
        return (
          <span className="run__g run__g--actable">
            <span
              className={`run__g-rest run__dot ${s.status.code === 0 ? "run__dot--exited" : "run__dot--failed"}`}
            />
            {act(
              "Run again",
              rerun ?? (() => void restartRun(s.id)),
              <PlayFillIcon />,
            )}
          </span>
        );
      case "failed":
        return (
          <span className="run__g run__g--actable">
            <span className="run__g-rest run__dot run__dot--failed" />
            {act(
              "Run again",
              rerun ?? (() => void restartRun(s.id)),
              <PlayFillIcon />,
            )}
          </span>
        );
    }
  };

  return (
    <div className="run">
      <div className="run__config">
        <span className="form__label">Run in</span>
        <Dropdown
          className="run__target"
          options={targets}
          value={target}
          onChange={setTarget}
          ariaLabel="Run target directory"
        />

        <div className="run__sect">
          <span className="form__label">Commands</span>
          <button
            type="button"
            className="run__sect-add"
            onClick={draft ? closeDraft : openAdd}
            title="Add command"
            aria-label="Add command"
            aria-expanded={draft !== null}
          >
            +
          </button>
        </div>

        {draft && (
          // The command form lives ABOVE the list and only while in use.
          <div className="run__form">
            <textarea
              {...noAutoCorrect}
              className="form__input run__command"
              value={command}
              rows={3}
              autoFocus
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                // Enter inserts a newline (multi-line commands are
                // legitimate shell); ⌘/Ctrl+Enter saves.
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  saveDraft();
                }
              }}
              placeholder="e.g. pnpm dev — $KEEPDECK_PORT is yours to use"
              aria-label="Command to run"
            />
            <input
              {...noAutoCorrect}
              className="form__input run__save-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name (optional)"
              aria-label="Preset name"
            />
            <div className="run__launch">
              <button
                type="button"
                className="form__cancel run__go"
                onClick={closeDraft}
              >
                Cancel
              </button>
              <button
                type="button"
                className="form__create run__go"
                disabled={!command.trim()}
                onClick={saveDraft}
                title={command.trim() ? "Save the command" : "Type a command first"}
              >
                {draft.presetId ? "Save" : "Add"}
              </button>
            </div>
          </div>
        )}

        {rows.length === 0 && !draft && (
          <div className="run__empty">
            <span className="run__empty-title">No run commands yet</span>
            <span className="run__empty-sub">
              Add one to launch the app you're building —{" "}
              <code>$KEEPDECK_PORT</code>, the worktree and its branch come
              preset.
            </span>
          </div>
        )}

        <ul className="run__cmds">
          {rows.map((row) => {
            const rowName = row.preset?.name ?? row.session!.name;
            // Namespaced: preset ids (`run-N`) and session ids must never
            // produce the same key even if their numbers coincide.
            const key = row.preset ? `p:${row.preset.id}` : `s:${row.session!.id}`;
            return (
              <li key={key} className="run__item">
                <div
                  className={`run__cmd${row.session && shown?.id === row.session.id ? " run__cmd--active" : ""}`}
                  onClick={
                    row.session ? () => pick(row.session!.id) : undefined
                  }
                >
                  {glyph(
                    row.session,
                    rowName,
                    row.preset ? () => launchPreset(row.preset!) : undefined,
                    row.preset ? () => launchPreset(row.preset!) : undefined,
                  )}
                  <span className="run__cmd-name" title={row.preset?.command ?? row.session?.command}>
                    {rowName}
                  </span>
                  <span className="run__cmd-acts">
                    {row.preset ? (
                      <>
                        <button
                          type="button"
                          className="run__act"
                          onClick={(e) => {
                            e.stopPropagation();
                            startEditing(row.preset!.id);
                          }}
                          title={`Edit "${rowName}"`}
                          aria-label={`Edit preset ${rowName}`}
                        >
                          <EditIcon />
                        </button>
                        <button
                          type="button"
                          className="run__act"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!ws.run) return;
                            onSetRun(removePreset(ws.run, row.preset!.id));
                            // Dead sessions of a deleted command are swept —
                            // a same-named orphan row reading as "the delete
                            // didn't work" was exactly the reported bug; a
                            // RUNNING one stays visible until it stops.
                            removeDeadRunsFor(ws.id, row.preset!.id);
                          }}
                          title={`Delete "${rowName}"`}
                          aria-label={`Delete preset ${rowName}`}
                        >
                          <CloseIcon />
                        </button>
                      </>
                    ) : (
                      // An orphan: its preset is gone — only the session
                      // itself can be dismissed (killing it if alive).
                      <button
                        type="button"
                        className="run__act"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeRun(row.session!.id);
                        }}
                        title="Remove (kills the process if it still runs)"
                        aria-label={`Remove run ${rowName}`}
                      >
                        <CloseIcon />
                      </button>
                    )}
                  </span>
                  <span
                    className={`run__cmd-meta${metaBad(row.session) ? " run__cmd-meta--bad" : ""}`}
                  >
                    {sessionNote(row.session)}
                  </span>
                </div>
                {row.elsewhere.map((s) => (
                  <div
                    key={s.id}
                    className={`run__cmd run__cmd--child${shown?.id === s.id ? " run__cmd--active" : ""}`}
                    onClick={() => pick(s.id)}
                  >
                    {glyph(
                      s,
                      `${rowName} (${targetLabel(s)})`,
                      undefined,
                      row.preset
                        ? () =>
                            launchPreset(row.preset!, {
                              worktree: s.worktree,
                              ...(s.branch && { branch: s.branch }),
                            })
                        : undefined,
                    )}
                    <span className="run__cmd-name" title={s.worktree}>
                      {targetLabel(s)}
                    </span>
                    <span className="run__cmd-acts">
                      <button
                        type="button"
                        className="run__act"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeRun(s.id);
                        }}
                        title="Remove (kills the process if it still runs)"
                        aria-label={`Remove run ${rowName} in ${targetLabel(s)}`}
                      >
                        <CloseIcon />
                      </button>
                    </span>
                    <span
                      className={`run__cmd-meta${metaBad(s) ? " run__cmd-meta--bad" : ""}`}
                    >
                      {sessionNote(s)}
                    </span>
                  </div>
                ))}
              </li>
            );
          })}
        </ul>
      </div>

      {shown && (
        <div className="run__logbox">
          <div className="run__logcap" title={`${shown.command} · ${shown.worktree}`}>
            <span className="run__logcap-text">
              <b>{shown.name}</b> · {targetLabel(shown)}
              {sessionNote(shown) && <> · {sessionNote(shown)}</>}
            </span>
            <button
              type="button"
              className="run__logcap-close"
              onClick={() => setLogOpen(false)}
              title="Hide the log"
              aria-label="Hide the log"
            >
              <CloseIcon />
            </button>
          </div>
          <RunLog key={shown.id} sessionId={shown.id} cwd={shown.worktree} />
        </div>
      )}
    </div>
  );
}

/** The row's muted note: the port while alive, the outcome after. */
function sessionNote(s: RunSession | undefined): string {
  if (!s) return "";
  switch (s.status.kind) {
    case "running":
      return s.port !== undefined ? `:${s.port}` : "";
    case "stopping":
      return "stopping…";
    case "exited":
      return s.status.code === null ? "terminated" : `exit ${s.status.code}`;
    case "failed":
      return "spawn failed";
  }
}

/** Whether the note reads as a failure (colors the meta). */
function metaBad(s: RunSession | undefined): boolean {
  if (!s) return false;
  return (
    s.status.kind === "failed" ||
    (s.status.kind === "exited" && s.status.code !== 0 && s.status.code !== null)
  );
}

/** Last two path segments — enough to tell worktrees apart in a list. */
function shortPath(path: string): string {
  return path.split("/").filter(Boolean).slice(-2).join("/");
}
