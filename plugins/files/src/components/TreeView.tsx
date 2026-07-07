import { ChevronDownIcon } from "@keepdeck/ui-kit/icons";
import type { TreeNode, TreeRow } from "../domain/tree";
import { PANE_PATH_DROP_TYPE } from "../dnd";
import { FileIcon, FolderIcon, SymlinkIcon } from "../icons";

/**
 * The tree body: the flat list of visible rows (`visibleRows(state)`), each
 * indented by its depth. A directory row toggles; a file/symlink row selects.
 * Rendering from the pre-flattened rows keeps this component free of tree
 * recursion — the model already resolved what is visible. The `role="tree"`
 * and keyboard focus live on the parent container (`FilesTab`); rows are the
 * `treeitem`s. `cursorPath` is the keyboard-focused row.
 */
export function TreeView({
  rows,
  cursorPath,
  onToggle,
  onSelect,
}: {
  rows: TreeRow[];
  cursorPath: string | null;
  onToggle: (path: string) => void;
  onSelect: (node: TreeNode) => void;
}) {
  return (
    <ul className="files__list" role="presentation">
      {rows.map(({ node, depth }) => (
        <TreeRowItem
          key={node.path}
          node={node}
          depth={depth}
          active={node.path === cursorPath}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

function TreeRowItem({
  node,
  depth,
  active,
  onToggle,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  active: boolean;
  onToggle: (path: string) => void;
  onSelect: (node: TreeNode) => void;
}) {
  const isDir = node.kind === "dir";
  return (
    <li role="none">
      <div
        className={`files__row${active ? " files__row--sel" : ""}`}
        style={{ paddingLeft: `${6 + depth * 14}px` }}
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={isDir ? node.expanded : undefined}
        aria-selected={active}
        data-cursor={active ? "true" : undefined}
        title={node.path}
        // Drag a row onto a pane to drop its path into that terminal. The host
        // reads this type and delivers it (src/app/usePaneDrop); a click still
        // opens/toggles, since a click without movement isn't a drag.
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(PANE_PATH_DROP_TYPE, node.path);
          event.dataTransfer.effectAllowed = "copy";
        }}
        onClick={() => (isDir ? onToggle(node.path) : onSelect(node))}
      >
        <span
          className={`files__chevron${
            isDir && !node.expanded ? " files__chevron--collapsed" : ""
          }`}
        >
          {isDir && <ChevronDownIcon />}
        </span>
        <span className="files__ficon">{glyph(node)}</span>
        <span className="files__name">{node.name}</span>
        {node.loading && <span className="files__hint">…</span>}
        {node.error && (
          <span className="files__hint files__hint--bad" title={node.error}>
            !
          </span>
        )}
      </div>
    </li>
  );
}

function glyph(node: TreeNode) {
  switch (node.kind) {
    case "dir":
      return <FolderIcon />;
    case "symlink":
      return <SymlinkIcon />;
    default:
      return <FileIcon />;
  }
}
