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
 * The Run tab: launch the app under development in a chosen worktree —
 * saved presets in one click, or an ad-hoc (multi-line) command, optionally
 * saved as a preset on the way. Below the launcher: this workspace's live
 * runs and the selected run's log. Everything here drives `runManager`;
 * nothing touches the agent grid.
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
  const [save, setSave] = useState(false);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  // The preset whose ✎ loaded the drafts: the command form is in edit mode —
  // submitting REWRITES that preset (no launch) instead of running ad hoc.
  const [editing, setEditing] = useState<string | null>(null);

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

  const resetDrafts = () => {
    setEditing(null);
    setCommand("");
    setSave(false);
    setName("");
  };

  const startEditing = (presetId: string) => {
    const preset = ws.run?.presets.find((p) => p.id === presetId);
    if (!preset) return;
    setEditing(presetId);
    setCommand(preset.command);
    setName(preset.name);
    setSave(false);
  };

  const submit = () => {
    const line = command.trim();
    if (!line) return;
    if (editing) {
      if (ws.run) onSetRun(updatePreset(ws.run, editing, name, line));
      resetDrafts();
      return;
    }
    if (save) {
      const next = addPreset(ws.run, name, line);
      const created = next.presets[next.presets.length - 1];
      onSetRun(next);
      launch({ presetId: created.id, command: line, name: created.name });
    } else {
      launch({ command: line, name: line });
    }
    resetDrafts();
  };

  return (
    <div className="run">
      <span className="form__label">Run in</span>
      <Dropdown
        className="run__target"
        options={targets}
        value={target}
        onChange={setTarget}
        ariaLabel="Run target directory"
      />

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

      <span className="form__label">Command</span>
      <textarea
        {...noAutoCorrect}
        className="form__input run__command"
        value={command}
        rows={3}
        onChange={(e) => setCommand(e.target.value)}
        onKeyDown={(e) => {
          // Enter inserts a newline (multi-line commands are legitimate
          // shell); ⌘/Ctrl+Enter submits (run, or save while editing).
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={"e.g. pnpm dev — $KEEPDECK_PORT is yours to use\n⌘⏎ runs"}
        aria-label="Command to run"
      />
      <div className="run__launch">
        {editing ? (
          <button type="button" className="form__cancel run__go" onClick={resetDrafts}>
            Cancel
          </button>
        ) : (
          <label className="run__save">
            <input
              type="checkbox"
              checked={save}
              onChange={(e) => setSave(e.target.checked)}
            />
            <span>Save as preset</span>
          </label>
        )}
        <button
          type="button"
          className="form__create run__go"
          disabled={!command.trim()}
          onClick={submit}
          title={
            !command.trim()
              ? "Type a command first"
              : editing
                ? "Save the preset"
                : "Run the command"
          }
        >
          {editing ? "Save" : "Run"}
        </button>
      </div>
      {(save || editing) && (
        <input
          {...noAutoCorrect}
          className="form__input run__save-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Preset name (optional)"
          aria-label="Preset name"
        />
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
