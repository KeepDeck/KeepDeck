/**
 * The worktree location field's whole mind: where the team will run.
 *
 * Its own hook because it is its own feature — a path, the disk probe behind
 * it, a branch that follows the path until someone edits it, the base that
 * branch forks from, and the deck's word on who is already there. Four of the
 * dialog's injected collaborators are its and nobody else's, and every one of
 * them is async, which is what made this the heaviest quarter of a component
 * that also owned a session picker and a remote endpoint.
 */
import { useEffect, useRef, useState } from "react";
import {
  classifyLocation,
  isKnownBaseBranch,
  type AgentLocation,
  type DirectoryState,
  type LocationKind,
  type PathProbe,
} from "../../domain/agents";

export interface WorktreeLocationDeps {
  /** The workspace repo when its cwd is a git repo; null hides the field. */
  repo: { cwd: string; branch: string | null } | null;
  suggestedPath: string;
  suggestedBranch: string;
  probePath(path: string): Promise<PathProbe>;
  listBranches(repo: string): Promise<string[]>;
  branchForPath(path: string): Promise<string | null>;
  directoryAt(path: string): DirectoryState;
  nextFreeLocation(
    currentPath: string,
  ): Promise<{ path: string; branch: string } | null>;
  pickFolder(title: string): Promise<string | null>;
}

export interface WorktreeLocation {
  path: string;
  setPath(next: string): void;
  branch: string;
  setBranch(next: string): void;
  baseBranch: string;
  setBaseBranch(next: string): void;
  /** Null until (unless) the listing lands — validation is off without one,
   * so a dead IPC degrades the picker to free text instead of blocking. */
  branches: string[] | null;
  /** The branch the current path implies, for the ↺ reset. */
  derivedBranch: string;
  probe: PathProbe | null;
  /** What the path IS right now — gates Create. */
  kind: LocationKind;
  /** What the LAYOUT renders: the last settled kind, so the fields do not
   * unmount on every keystroke's "checking". */
  layoutKind: LocationKind;
  baseOk: boolean;
  buildLocation(): AgentLocation;
  useNextFree(): Promise<void>;
  choosePath(): Promise<void>;
}

export function useWorktreeLocation(deps: WorktreeLocationDeps): WorktreeLocation {
  const {
    repo,
    suggestedPath,
    suggestedBranch,
    probePath,
    listBranches,
    branchForPath,
    directoryAt,
    nextFreeLocation,
    pickFolder,
  } = deps;
  const [path, setPath] = useState(suggestedPath);
  const [branch, setBranch] = useState(suggestedBranch);
  // The base the new worktree branch forks from. Prefilled with the repo's
  // current branch, so the field always NAMES its base instead of implying
  // one through a placeholder. Cleared — or opened on a detached HEAD — it
  // falls back to the repo HEAD, the default since before the picker existed.
  const [baseBranch, setBaseBranch] = useState(repo?.branch ?? "");
  const [branches, setBranches] = useState<string[] | null>(null);
  // Equality is the whole edit-tracking: while `branch === derivedBranch` the
  // branch is untouched and keeps following; an edit detaches it; the ↺ reset
  // restores equality and re-attaches — SuggestedInput's own state machine.
  const [derivedBranch, setDerivedBranch] = useState(suggestedBranch);
  const derivedRef = useRef(suggestedBranch);
  const [probe, setProbe] = useState<PathProbe | null>(null);

  // Live-probe the entered path (debounced) to drive the hint. A null probe
  // while a non-empty path is pending reads as "checking".
  useEffect(() => {
    if (!repo || !path.trim()) {
      setProbe(null);
      return;
    }
    setProbe(null);
    let cancelled = false;
    const timer = setTimeout(() => {
      probePath(path)
        .then((p) => {
          if (!cancelled) setProbe(p);
        })
        .catch(() => {
          if (!cancelled)
            setProbe({ exists: false, isWorktree: false, empty: false, branch: null });
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, repo]);

  // Load the base-branch options once per dialog: the workspace repo is fixed
  // for its lifetime. A failure just leaves `branches` null (see above).
  useEffect(() => {
    if (!repo) return;
    let cancelled = false;
    listBranches(repo.cwd)
      .then((list) => {
        if (!cancelled) setBranches(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo]);

  // Follow the path with the branch (debounced like the probe): an untouched
  // branch — one still equal to the suggestion it came from — moves to the new
  // path's implied branch; an edited one stays the user's.
  useEffect(() => {
    if (!repo || !path.trim()) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      branchForPath(path)
        .then((b) => {
          if (cancelled || b === null) return;
          const previous = derivedRef.current;
          setBranch((prev) => (prev === previous ? b : prev));
          derivedRef.current = b;
          setDerivedBranch(b);
        })
        .catch(() => {});
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, repo]);

  const deckSays = repo && path.trim() ? directoryAt(path) : "free";
  const kind = repo ? classifyLocation(path, probe, deckSays) : "main";
  // "checking" is the only transient kind, and every keystroke passes through
  // it — unmounting the Branch/Base fields on each one made the whole dialog
  // jump. The last settled kind holds the layout still; `kind` itself keeps
  // gating Create, so nothing can be submitted against a stale read. Seeded
  // optimistically: a prefilled path was already probed free by the opener,
  // so the dialog opens at its full height instead of growing a beat later.
  const settledKindRef = useRef<LocationKind>(suggestedPath.trim() ? "new" : "main");
  if (kind !== "checking") settledKindRef.current = kind;

  return {
    path,
    setPath,
    branch,
    setBranch,
    baseBranch,
    setBaseBranch,
    branches,
    derivedBranch,
    probe,
    kind,
    layoutKind: settledKindRef.current,
    baseOk: isKnownBaseBranch(baseBranch, branches),
    buildLocation: () => {
      if (kind === "new")
        return {
          kind: "new",
          path: path.trim(),
          branch: branch.trim(),
          baseBranch: baseBranch.trim() || undefined,
        };
      if (kind === "existing")
        return { kind: "existing", path: path.trim(), branch: (probe?.branch ?? "").trim() };
      return { kind: "main" };
    },
    // Swap the unusable path (and its branch) for the next free suggestion.
    // A null result (no base, IPC down) leaves the field as is — the blocking
    // hint still explains the state.
    useNextFree: async () => {
      const free = await nextFreeLocation(path);
      if (free) {
        setPath(free.path);
        setBranch(free.branch);
      }
    },
    // "Choose…" picks the worktree folder itself — the agent's project lives
    // directly in it, not in a subfolder ([F2]). git accepts a non-existent or
    // existing-empty dir; the field stays editable for typing a fresh path.
    choosePath: async () => {
      const dir = await pickFolder("Choose the worktree folder");
      if (dir !== null) setPath(dir);
    },
  };
}
