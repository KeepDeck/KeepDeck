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
 * The Files tab: a lazy tree of the chosen root, plus a read-only viewer for
 * the selected file. The root is a pane's worktree or the workspace folder,
 * defaulting to the highlighted pane's worktree — "browse what I'm looking at"
 * — and following the highlight, exactly like the Run tab's target; a manual
 * pick holds only until the next pane click. Everything reads through the fs
 * capability's scope, so only the workspace and its worktrees are reachable.
 *
 * Two cursors: `cursor` is the keyboard-focused row (arrow navigation);
 * `preview` is the file shown below. Clicking or arrowing onto a file previews
 * it, so the tree is fully drivable from the keyboard once it has focus.
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
  const openFile = (node: TreeNode) => {
    setCursor(node.path);
    setPreview(node.path);
    focusTree();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const key = ARROW_KEYS[event.key];
    if (!key) return;
    event.preventDefault();
    const action = navigate(state, cursor, key);
    if (action.expand) toggle(action.expand);
    if (action.collapse) toggle(action.collapse);
    if (action.cursor === cursor) return;
    setCursor(action.cursor);
    const node = action.cursor ? state.nodes[action.cursor] : null;
    // Arrow-to-view: landing on a file previews it, like clicking it.
    if (node && node.kind !== "dir") setPreview(node.path);
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
            onSelect={openFile}
          />
        )}
      </div>

      {preview && (
        <FileViewer
          key={preview}
          path={preview}
          onClose={() => setPreview(null)}
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
