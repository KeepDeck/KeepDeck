import { useRef, useState } from "react";
import type { DockTabProps } from "@keepdeck/plugin-api";
import { Dropdown } from "@keepdeck/ui-kit/Dropdown";
import { RefreshIcon } from "@keepdeck/ui-kit/icons";
import { useFileTree } from "./useFileTree";
import { visibleRows } from "../domain/tree";
import { TreeView } from "./TreeView";
import { FileViewer } from "./FileViewer";

/**
 * The Files tab: a lazy tree of the chosen root, plus a read-only viewer for
 * the selected file. The root is a pane's worktree or the workspace folder,
 * defaulting to the highlighted pane's worktree — "browse what I'm looking at"
 * — and following the highlight, exactly like the Run tab's target; a manual
 * pick holds only until the next pane click. Everything reads through the fs
 * capability's scope, so only the workspace and its worktrees are reachable.
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
  const [selected, setSelected] = useState<string | null>(null);

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

      <div className="files__tree">
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
            selectedPath={selected}
            onToggle={toggle}
            onSelect={(node) => setSelected(node.path)}
          />
        )}
      </div>

      {selected && (
        <FileViewer
          key={selected}
          path={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

/** Last two path segments — enough to tell worktrees apart in the dropdown. */
function shortPath(path: string): string {
  return path.split("/").filter(Boolean).slice(-2).join("/");
}
