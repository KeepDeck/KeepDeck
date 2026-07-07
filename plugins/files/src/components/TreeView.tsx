import { ChevronDownIcon } from "@keepdeck/ui-kit/icons";
import type { TreeNode, TreeRow } from "../domain/tree";
import { FileIcon, FolderIcon, SymlinkIcon } from "../icons";

/**
 * The tree body: the flat list of visible rows (`visibleRows(state)`), each
 * indented by its depth. A directory row toggles; a file/symlink row selects.
 * Rendering from the pre-flattened rows keeps this component free of tree
 * recursion — the model already resolved what is visible.
 */
export function TreeView({
  rows,
  selectedPath,
  onToggle,
  onSelect,
}: {
  rows: TreeRow[];
  selectedPath: string | null;
  onToggle: (path: string) => void;
  onSelect: (node: TreeNode) => void;
}) {
  return (
    <ul className="files__list" role="tree" aria-label="Project files">
      {rows.map(({ node, depth }) => (
        <TreeRowItem
          key={node.path}
          node={node}
          depth={depth}
          selected={node.path === selectedPath}
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
  selected,
  onToggle,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selected: boolean;
  onToggle: (path: string) => void;
  onSelect: (node: TreeNode) => void;
}) {
  const isDir = node.kind === "dir";
  return (
    <li role="none">
      <div
        className={`files__row${selected ? " files__row--sel" : ""}`}
        style={{ paddingLeft: `${6 + depth * 14}px` }}
        role="treeitem"
        aria-expanded={isDir ? node.expanded : undefined}
        aria-selected={selected}
        title={node.path}
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
