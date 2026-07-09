import { useEffect, useRef, useState } from "react";
import type { DockTabProps } from "@keepdeck/plugin-api";
import { Dropdown } from "@keepdeck/ui-kit/Dropdown";
import { RefreshIcon } from "@keepdeck/ui-kit/icons";
import { useFileTree } from "./useFileTree";
import { visibleRows, type TreeNode } from "../domain/tree";
import { navigate, type ArrowKey } from "../domain/navigate";
import { TreeView } from "./TreeView";
import { FileViewer } from "./FileViewer";

/**
 * The Files tab: a lazy tree of the chosen root. Opening a file lifts it into a
 * wide "peek" over the whole window (a 340px rail can't read code — see
 * FileViewer); the tree stays here as the navigator. The root is a pane's
 * worktree or the workspace folder, defaulting to the highlighted pane's
 * worktree — "browse what I'm looking at" — and following the highlight like the
 * Run tab's target; a manual pick holds until the next pane click. Everything
 * reads through the fs capability's scope, so only the workspace and its
 * worktrees are reachable.
 *
 * `cursor` is the keyboard-focused row; arrows move it (and expand/collapse).
 * Enter or a DOUBLE click opens the focused file into the peek — a single
 * click only selects the row (aim, drag, keyboard handoff); the tree stays
 * mounted so its cursor and scroll survive the round trip.
 */
export function FilesTab({ workspace, selectedPaneId }: DockTabProps) {
  const [target, setTarget] = useState(
    () =>
      workspace.panes.find((pane) => pane.id === selectedPaneId)?.cwd ??
      workspace.cwd,
  );
  // Follow the highlighted pane (same seen-ref idiom as the Run tab).
  const seenSelectedRef = useRef(selectedPaneId);
  if (seenSelectedRef.current !== selectedPaneId) {
    seenSelectedRef.current = selectedPaneId;
    const followed = workspace.panes.find(
      (pane) => pane.id === selectedPaneId,
    )?.cwd;
    if (followed && followed !== target) setTarget(followed);
  }

  const { state, toggle, refresh } = useFileTree(target);
  const [cursor, setCursor] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  // A new root starts fresh — drop the keyboard cursor and any open preview.
  useEffect(() => {
    setCursor(null);
    setPreview(null);
  }, [target]);

  // Keep the focused row in view as the cursor moves.
  useEffect(() => {
    if (!cursor) return;
    treeRef.current
      ?.querySelector('[data-cursor="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  // Distinct roots: each pane worktree once, the workspace folder last (a
  // pane attached to the main repo can't duplicate it).
  const targets = [
    ...[
      ...new Map(
        workspace.panes
          .filter((pane) => pane.cwd && pane.cwd !== workspace.cwd)
          .map((pane) => [pane.cwd!, pane.branch ?? shortPath(pane.cwd!)]),
      ).entries(),
    ].map(([value, label]) => ({ value, label })),
    { value: workspace.cwd, label: "Workspace folder" },
  ];

  const rows = visibleRows(state);

  const focusTree = () => treeRef.current?.focus();
  const openDir = (path: string) => {
    setCursor(path);
    focusTree();
    toggle(path);
  };
  // Single click: take the cursor (and keyboard focus) without opening — the
  // peek covers the window, too disruptive for a mere aim-or-drag click.
  const focusFile = (node: TreeNode) => {
    setCursor(node.path);
    focusTree();
  };
  const openFile = (node: TreeNode) => {
    setCursor(node.path);
    setPreview(node.path);
    focusTree();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Enter / Space activate the focused row: open a file, toggle a directory.
    if (event.key === "Enter" || event.key === " ") {
      const node = cursor ? state.nodes[cursor] : null;
      if (!node) return;
      event.preventDefault();
      if (node.kind === "dir") toggle(node.path);
      else openFile(node);
      return;
    }
    const key = ARROW_KEYS[event.key];
    if (!key) return;
    event.preventDefault();
    const action = navigate(state, cursor, key);
    if (action.expand) toggle(action.expand);
    if (action.collapse) toggle(action.collapse);
    if (action.cursor !== cursor) setCursor(action.cursor);
  };

  return (
    <div className="files">
      <div className="files__bar">
        <Dropdown
          className="files__root"
          options={targets}
          value={target}
          onChange={setTarget}
          ariaLabel="File tree root directory"
        />
        <button
          type="button"
          className="files__refresh"
          onClick={refresh}
          title="Reload from disk"
          aria-label="Reload the file tree from disk"
        >
          <RefreshIcon />
        </button>
      </div>

      <div
        className="files__tree"
        ref={treeRef}
        role="tree"
        aria-label="Project files"
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        {rows.length === 0 ? (
          <div className="files__empty">
            {state.nodes[target]?.error ? (
              <span className="files__empty-sub">
                {state.nodes[target].error}
              </span>
            ) : state.nodes[target]?.loaded ? (
              <span className="files__empty-sub">This folder is empty.</span>
            ) : (
              <span className="files__empty-sub">Loading…</span>
            )}
          </div>
        ) : (
          <TreeView
            rows={rows}
            cursorPath={cursor}
            onToggle={openDir}
            onSelect={focusFile}
            onOpen={openFile}
          />
        )}
      </div>

      {preview && (
        <FileViewer
          path={preview}
          root={target}
          onClose={() => {
            setPreview(null);
            focusTree();
          }}
        />
      )}
    </div>
  );
}

/** Arrow keys the tree consumes, mapped to the pure navigator's vocabulary. */
const ARROW_KEYS: Record<string, ArrowKey | undefined> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/** Last two path segments — enough to tell worktrees apart in the dropdown. */
function shortPath(path: string): string {
  return path.split("/").filter(Boolean).slice(-2).join("/");
}
