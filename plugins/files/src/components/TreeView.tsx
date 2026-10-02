import { ChevronDownIcon } from "@keepdeck/ui-kit/icons";
import { VirtualList } from "@keepdeck/ui-kit/VirtualList";
import { TREE_ROW_ESTIMATE_PX } from "../presentation/treeLayout";
import type { TreeNode, TreeRow } from "../domain/tree";
import { FileIcon, FolderIcon, SymlinkIcon } from "../icons";

/**
 * The tree body: the flat list of visible rows (`visibleRows(state)`), each
 * indented by its depth, windowed — only the rows in view are mounted, so
 * an opened `node_modules` costs what the screen shows. A directory row toggles on click; a file/symlink row
 * SELECTS on click and only OPENS on double click — single click is for
 * aiming (cursor, drag) without lifting the peek over the window. Rendering
 * from the pre-flattened rows keeps this component free of tree recursion —
 * the model already resolved what is visible. The `role="tree"` and keyboard
 * focus live on the parent container (`FilesTab`); rows are the `treeitem`s.
 * `cursorPath` is the keyboard-focused row, kept in view as it moves.
 */
export function TreeView({
  rows,
  cursorPath,
  onToggle,
  onSelect,
  onOpen,
}: {
  rows: TreeRow[];
  cursorPath: string | null;
  onToggle: (path: string) => void;
  onSelect: (node: TreeNode) => void;
  onOpen: (node: TreeNode) => void;
}) {
  return (
    <VirtualList
      items={rows}
      itemKey={rowPath}
      estimate={TREE_ROW_ESTIMATE_PX}
      className="files__scroll"
      revealKey={cursorPath}
      render={({ node, depth }) => (
        <TreeRowItem
          node={node}
          depth={depth}
          active={node.path === cursorPath}
          onToggle={onToggle}
          onSelect={onSelect}
          onOpen={onOpen}
        />
      )}
    />
  );
}

function TreeRowItem({
  node,
  depth,
  active,
  onToggle,
  onSelect,
  onOpen,
}: {
  node: TreeNode;
  depth: number;
  active: boolean;
  onToggle: (path: string) => void;
  onSelect: (node: TreeNode) => void;
  onOpen: (node: TreeNode) => void;
}) {
  const isDir = node.kind === "dir";
  return (
    <div
      className={`files__row${active ? " files__row--sel" : ""}`}
      style={{ paddingLeft: `${6 + depth * 14}px` }}
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={isDir ? node.expanded : undefined}
      aria-selected={active}
      data-cursor={active ? "true" : undefined}
      title={node.path}
      // Drag a row onto a pane's terminal to drop its path in. The host owns
      // the pointer drag and reads this attribute (src/app/usePaneDrag); a
      // click still selects/toggles, since a click without movement isn't a drag.
      data-kd-drag-path={node.path}
      onClick={() => (isDir ? onToggle(node.path) : onSelect(node))}
      // The double click's own two clicks have already selected the row —
      // opening is strictly additive, so no gesture is lost.
      onDoubleClick={isDir ? undefined : () => onOpen(node)}
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
  );
}

const rowPath = (row: TreeRow): string => row.node.path;


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
