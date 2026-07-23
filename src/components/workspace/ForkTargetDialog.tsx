import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentInfo } from "../../domain/agents";
import {
  agentSupportsYolo,
  canCreateAgent,
  classifyLocation,
  type LocationKind,
  type Occupancy,
  type PathProbe,
} from "../../domain/agents";
import type { SessionHandle } from "../../domain/journal";
import { baseName } from "../../domain/deck";
import type { ForkTarget } from "../../app/useJournalFork";
import { ModalOverlay } from "../../ui/ModalOverlay";
import { SuggestedInput } from "../../ui/SuggestedInput";
import { YoloField } from "../../ui/YoloField";
import { noAutoCorrect } from "../../ui/inputProps";

interface ForkTargetDialogProps {
  record: SessionHandle;
  agents: AgentInfo[];
  /** The workspace's own folder — the empty-path default target. */
  workspaceCwd: string;
  /** The YOLO toggle's starting position (the global preference); shown
   * only while the forked agent's plugin declares YOLO support. */
  defaultYolo: boolean;
  /** Probe a candidate path for the live hint (injected, like AgentDialog). */
  probe(path: string): Promise<PathProbe | null>;
  /** Whether a deck pane already runs in / targets `path`. */
  occupancy(path: string): Occupancy;
  /** Native folder picker; `null` = cancelled. */
  pickFolder(title: string): Promise<string | null>;
  onConfirm(result: { target: ForkTarget; yolo: boolean }): void;
  onCancel(): void;
}

/** The same path-driven location UX as the "+ Agent" dialog, reduced to the
 * fork's question: WHERE does the copy live? Empty → the workspace folder;
 * a new path → create a worktree there (branch required); an existing
 * worktree → attach the fork to it. */
export function ForkTargetDialog({
  record,
  agents,
  workspaceCwd,
  defaultYolo,
  probe,
  occupancy,
  pickFolder,
  onConfirm,
  onCancel,
}: ForkTargetDialogProps) {
  const [path, setPath] = useState("");
  const [branch, setBranch] = useState("");
  // Seeded from defaultYolo at mount; the forked agent is fixed for this
  // dialog's life, so supportsYolo never re-evaluates. Only the SUBMITTED
  // value is capability-gated (see the onSubmit handler below).
  const [yolo, setYolo] = useState(defaultYolo);
  const supportsYolo = agentSupportsYolo(agents, record.agent);
  const [probed, setProbed] = useState<PathProbe | null>(null);
  const probeSeq = useRef(0);
  const trimmed = path.trim();
  useEffect(() => {
    if (!trimmed) {
      setProbed(null);
      return;
    }
    const seq = ++probeSeq.current;
    setProbed(null);
    const timer = window.setTimeout(() => {
      void probe(trimmed).then((result) => {
        if (probeSeq.current === seq) setProbed(result);
      });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [trimmed, probe]);

  const kind: LocationKind = classifyLocation(trimmed, probed, occupancy(trimmed));
  const valid = canCreateAgent(kind, kind === "new" ? branch : "-");

  // The branch suggestion follows the path's folder name until the user edits
  // the branch: while `branch === derived` it is untouched and keeps
  // following, an edit detaches it, the ↺ reset re-attaches — SuggestedInput's
  // own state machine (the same one the "+ Agent" dialog hand-rolls).
  const derived = baseName(trimmed);
  const derivedRef = useRef(derived);
  useEffect(() => {
    const previous = derivedRef.current;
    setBranch((prev) => (prev === previous ? derived : prev));
    derivedRef.current = derived;
  }, [derived]);

  const agentLabel =
    agents.find((a) => a.id === record.agent)?.label ?? record.agent;
  const hint = useMemo(() => {
    switch (kind) {
      case "main":
        return `Fork runs in the workspace folder — ${workspaceCwd}`;
      case "checking":
        return "Checking the path…";
      case "new":
        return "✓ New worktree will be created here";
      case "existing":
        return "✓ Existing worktree — the fork attaches to it";
      case "occupied":
        return "⚠ An agent already runs in this directory";
      case "blocked":
        return "⚠ The folder exists but is not a git worktree";
    }
  }, [kind, workspaceCwd]);

  const buildTarget = (): ForkTarget => {
    if (kind === "new") {
      return { kind: "worktree", path: trimmed, branch: branch.trim() };
    }
    if (kind === "existing") return { kind: "dir", cwd: trimmed };
    return { kind: "dir", cwd: workspaceCwd };
  };

  const choosePath = async () => {
    const dir = await pickFolder("Choose the fork's folder");
    if (dir !== null) setPath(dir);
  };

  return (
    <ModalOverlay>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onConfirm({ target: buildTarget(), yolo: yolo && supportsYolo });
        }}
      >
        <h2 className="form__title">Fork session</h2>
        <p className="form__desc">
          {record.title ?? agentLabel} — a new {agentLabel} conversation
          continuing from this session; the original stays untouched
        </p>

        <span className="form__label">Where</span>
        <div className="form__path">
          <div className="form__field form__path-field">
            <input
              {...noAutoCorrect}
              className="form__input form__field-input"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="Empty = the workspace folder"
              aria-label="Fork path"
              autoFocus
            />
            {trimmed !== "" && (
              <button
                type="button"
                className="form__field-btn"
                aria-label="Clear path"
                onClick={() => setPath("")}
              >
                ×
              </button>
            )}
          </div>
          <button type="button" className="form__dir-btn" onClick={() => void choosePath()}>
            Choose…
          </button>
        </div>
        <p className="form__git" title={hint}>
          {hint}
        </p>

        {kind === "new" && (
          <>
            <span className="form__label">Branch</span>
            <SuggestedInput
              value={branch}
              suggestion={derived}
              onChange={setBranch}
              className="form__field--gap"
              ariaLabel="Branch name"
              resetTitle="Reset to the suggested branch"
            />
          </>
        )}

        {supportsYolo && <YoloField checked={yolo} onChange={setYolo} />}

        <div className="form__actions">
          <button type="button" className="form__cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="form__create" disabled={!valid}>
            Fork
          </button>
        </div>
      </form>
    </ModalOverlay>
  );
}
