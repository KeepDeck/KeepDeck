import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentInfo } from "../../domain/agents";
import {
  canCreateAgent,
  classifyLocation,
  type LocationKind,
  type Occupancy,
  type PathProbe,
} from "../../domain/agents";
import type { SessionRecord } from "../../domain/journal";
import type { ForkTarget } from "../../app/useJournalFork";
import { ModalOverlay } from "../../ui/ModalOverlay";

interface ForkTargetDialogProps {
  record: SessionRecord;
  agents: AgentInfo[];
  /** The workspace's own folder — the empty-path default target. */
  workspaceCwd: string;
  /** Probe a candidate path for the live hint (injected, like AgentDialog). */
  probe(path: string): Promise<PathProbe | null>;
  /** Whether a deck pane already runs in / targets `path`. */
  occupancy(path: string): Occupancy;
  /** Native folder picker; `null` = cancelled. */
  pickFolder(title: string): Promise<string | null>;
  onConfirm(target: ForkTarget): void;
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
  probe,
  occupancy,
  pickFolder,
  onConfirm,
  onCancel,
}: ForkTargetDialogProps) {
  const [path, setPath] = useState("");
  const [branch, setBranch] = useState("");
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
          if (valid) onConfirm(buildTarget());
        }}
      >
        <h2 className="form__title">Fork session</h2>
        <p className="form__git">
          {record.title ?? agentLabel} — a new {agentLabel} conversation
          continuing from this session; the original stays untouched
        </p>

        <span className="form__label">Where</span>
        <div className="form__path">
          <input
            className="form__input"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="Empty = the workspace folder"
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
          <button type="button" className="form__dir-btn" onClick={() => void choosePath()}>
            Choose…
          </button>
        </div>
        <p className="form__git">{hint}</p>

        {kind === "new" && (
          <>
            <span className="form__label">Branch</span>
            <input
              className="form__input"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="Branch for the new worktree"
            />
          </>
        )}

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
