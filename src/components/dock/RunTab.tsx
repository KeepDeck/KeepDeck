import { useRef, useState } from "react";
import { launchRun, removeRun, restartRun, stopRun } from "../../app/runManager";
import { useRunSessions } from "../../app/useRunSessions";
import { addPreset, removePreset, updatePreset } from "../../domain/runPresets";
import type { RunRequest, RunSession } from "../../domain/runSessions";
import { Dropdown } from "../../ui/Dropdown";
import { noAutoCorrect } from "../../ui/inputProps";
import { CloseIcon, EditIcon, PlayIcon } from "../../ui/icons";
import { RunLog } from "./RunLog";
import type { DockTabProps } from "./tabs";

/**
 * The Run tab: launch the app under development in a chosen worktree — each
 * saved command is one click on its row. The command form stays collapsed
 * behind "Add command" (and opens ABOVE the list, also serving a row's ✎
 * edits). Below: this workspace's live runs and the selected run's log.
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
  // The command form is collapsed behind "Add command" (`null`); open, it
  // either adds a new preset (`presetId: null`) or — via a row's ✎ —
  // rewrites an existing one.
  const [draft, setDraft] = useState<{ presetId: string | null } | null>(null);

  const sessions = useRunSessions().filter((s) => s.wsId === ws.id);
  const shown =
    sessions.find((s) => s.id === picked) ?? sessions[sessions.length - 1];

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

  const launch = (request: RunRequest) => {
    const branch = ws.panes.find((p) => p.cwd === target)?.branch;
    void launchRun(
      ws.id,
      { worktree: target, ...(branch && { branch }) },
      request,
    ).then(setPicked);
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

  /** Add / Save — store the draft as a preset (rewrite when it came from a
   * row's ✎), never launching. Running is the preset row's job. */
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

      {draft ? (
        // The command form lives ABOVE the list and only while in use —
        // adding a command (or rewriting one, via a row's ✎).
        <div className="run__form">
          <span className="form__label">Command</span>
          <textarea
            {...noAutoCorrect}
            className="form__input run__command"
            value={command}
            rows={3}
            autoFocus
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              // Enter inserts a newline (multi-line commands are legitimate
              // shell); ⌘/Ctrl+Enter saves.
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
            placeholder="Preset name (optional)"
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
      ) : (
        <button type="button" className="run__add" onClick={openAdd}>
          + Add command
        </button>
      )}

      {(ws.run?.presets.length ?? 0) > 0 && (
        <>
          <span className="form__label">Presets</span>
          <ul className="run__presets">
            {ws.run!.presets.map((p) => (
              <li key={p.id} className="run__preset">
                {/* Name only: a command preview mangles multi-line scripts
                    and bloats the row — the full command lives in the
                    tooltip and behind ✎. */}
                <button
                  type="button"
                  className="run__preset-run"
                  onClick={() =>
                    launch({ presetId: p.id, command: p.command, name: p.name })
                  }
                  title={`Run: ${p.command}`}
                >
                  <PlayIcon />
                  <span className="run__preset-name">{p.name}</span>
                </button>
                <button
                  type="button"
                  className="run__preset-delete"
                  onClick={() => startEditing(p.id)}
                  title={`Edit preset "${p.name}"`}
                  aria-label={`Edit preset ${p.name}`}
                >
                  <EditIcon />
                </button>
                <button
                  type="button"
                  className="run__preset-delete"
                  onClick={() => ws.run && onSetRun(removePreset(ws.run, p.id))}
                  title={`Delete preset "${p.name}"`}
                  aria-label={`Delete preset ${p.name}`}
                >
                  <CloseIcon />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {sessions.length > 0 && (
        <>
          <span className="form__label">Sessions</span>
          <ul className="run__sessions">
            {sessions.map((s) => (
              <li
                key={s.id}
                className={`run__session${shown?.id === s.id ? " run__session--active" : ""}`}
              >
                <button
                  type="button"
                  className="run__session-pick"
                  onClick={() => setPicked(s.id)}
                  title={`${s.command} · ${s.worktree}`}
                >
                  <span className={`run__dot run__dot--${s.status.kind}`} />
                  <span className="run__session-name">{s.name}</span>
                  <span className="run__session-note">{sessionNote(s)}</span>
                </button>
                {s.status.kind === "running" ? (
                  <button
                    type="button"
                    className="run__session-act"
                    onClick={() => stopRun(s.id)}
                    title="Stop (SIGTERM, then SIGKILL after 3s)"
                  >
                    Stop
                  </button>
                ) : s.status.kind !== "stopping" ? (
                  <button
                    type="button"
                    className="run__session-act"
                    onClick={() => void restartRun(s.id)}
                    title="Run this command again"
                  >
                    Restart
                  </button>
                ) : null}
                <button
                  type="button"
                  className="run__preset-delete"
                  onClick={() => removeRun(s.id)}
                  title="Remove (kills the process if it still runs)"
                  aria-label={`Remove run ${s.name}`}
                >
                  <CloseIcon />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      </div>

      {shown && <RunLog key={shown.id} sessionId={shown.id} />}
    </div>
  );
}

/** The session row's muted note: the port while alive, the outcome after. */
function sessionNote(s: RunSession): string {
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

/** Last two path segments — enough to tell worktrees apart in a select. */
function shortPath(path: string): string {
  return path.split("/").filter(Boolean).slice(-2).join("/");
}
