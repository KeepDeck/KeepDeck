import type { FsEntry, FsEntryKind } from "@keepdeck/plugin-api";
import { sortEntries } from "./entries";

/**
 * The pure, lazy file-tree model. All state lives in a flat `path -> node` map
 * so every operation is an immutable transform testable without React or the
 * filesystem — the hook (`useFileTree`) is the only place that awaits
 * `services.fs` and feeds results back through these functions.
 *
 * Lazy: a directory's `children` are empty until `setChildren` lands them, and
 * `visibleRows` reveals a directory's subtree only when it is BOTH expanded and
 * loaded — so a giant `node_modules` costs nothing until someone opens it.
 */
export interface TreeNode {
  path: string;
  name: string;
  kind: FsEntryKind;
  /** Byte size of a regular file; absent for a directory or symlink. */
  size?: number;
  /** A directory the user has opened (meaningful for `dir` nodes only). */
  expanded: boolean;
  /** Its children have been fetched at least once. */
  loaded: boolean;
  /** A fetch of its children is in flight. */
  loading: boolean;
  /** The last fetch failed, with this reason. */
  error?: string;
  /** Ordered child paths, once loaded; empty otherwise. */
  children: string[];
}

export interface TreeState {
  /** The directory the tree is rooted at — never rendered as a row itself; its
   * children are the top level. */
  rootPath: string;
  nodes: Record<string, TreeNode>;
}

/** One row to render: a node plus its indentation depth (root's children = 0). */
export interface TreeRow {
  node: TreeNode;
  depth: number;
}

/** A fresh tree rooted at `rootPath`: just the (expanded, not-yet-loaded) root
 * node, ready for its children to be loaded. */
export function initTree(rootPath: string): TreeState {
  return {
    rootPath,
    nodes: {
      [rootPath]: dirNode(rootPath, baseName(rootPath), true),
    },
  };
}

/** Flag a node's children as being fetched. No-op on an unknown path. */
export function setLoading(state: TreeState, path: string): TreeState {
  return patch(state, path, { loading: true, error: undefined });
}

/** Record that a node's children failed to load. Clears `loading`. */
export function setError(
  state: TreeState,
  path: string,
  error: string,
): TreeState {
  return patch(state, path, { loading: false, error });
}

/**
 * Land a directory's children. Sorts them (dirs first), creates a node per
 * child, and marks the parent loaded. On a RE-load (refresh) it MERGES: an
 * existing child keeps its own expand/load state, and a child that vanished
 * from disk has its whole subtree pruned — so a refresh mirrors the disk
 * without collapsing what the user had open.
 */
export function setChildren(
  state: TreeState,
  path: string,
  entries: FsEntry[],
): TreeState {
  const parent = state.nodes[path];
  if (!parent) return state;

  const sorted = sortEntries(entries);
  // No-op guard: a watch-driven re-read of an UNCHANGED directory returns the
  // SAME state, so nothing re-renders. This keeps auto-refresh quiet when a
  // coarse fs event fires but the listing didn't actually change.
  if (parent.loaded && sameListing(parent, sorted, state.nodes)) return state;
  const nextChildren = sorted.map((entry) => entry.path);
  const nextSet = new Set(nextChildren);
  const nodes = { ...state.nodes };

  // Drop the subtrees of children that are no longer on disk.
  for (const old of parent.children) {
    if (!nextSet.has(old)) pruneSubtree(nodes, old);
  }

  // Create fresh child nodes; preserve an existing child's UI state on refresh.
  for (const entry of sorted) {
    const existing = nodes[entry.path];
    nodes[entry.path] = existing
      ? { ...existing, name: entry.name, kind: entry.kind, size: entry.size }
      : leafNode(entry);
  }

  nodes[path] = {
    ...parent,
    loaded: true,
    loading: false,
    error: undefined,
    children: nextChildren,
  };
  return { ...state, nodes };
}

/** Flip a directory's expanded flag. No-op on a non-directory or unknown path. */
export function toggleExpanded(state: TreeState, path: string): TreeState {
  const node = state.nodes[path];
  if (!node || node.kind !== "dir") return state;
  return patch(state, path, { expanded: !node.expanded });
}

/**
 * The visible rows, top to bottom: a depth-first walk from the root's children,
 * descending into a directory only when it is expanded AND loaded. Depth drives
 * indentation.
 */
export function visibleRows(state: TreeState): TreeRow[] {
  const rows: TreeRow[] = [];
  const root = state.nodes[state.rootPath];
  if (!root) return rows;

  const walk = (childPaths: string[], depth: number): void => {
    for (const childPath of childPaths) {
      const node = state.nodes[childPath];
      if (!node) continue;
      rows.push({ node, depth });
      if (node.kind === "dir" && node.expanded && node.loaded) {
        walk(node.children, depth + 1);
      }
    }
  };
  walk(root.children, 0);
  return rows;
}

/**
 * The directories a refresh should re-read: the root plus every currently
 * VISIBLE, loaded directory, parent-first (so a merge preserves child state).
 * A collapsed subtree is skipped — nothing is showing it, so re-reading it
 * would be wasted work.
 */
export function refreshTargets(state: TreeState): string[] {
  const targets = [state.rootPath];
  for (const { node } of visibleRows(state)) {
    if (node.kind === "dir" && node.loaded) targets.push(node.path);
  }
  return targets;
}

/** The last path segment — a display name for a full path. */
export function baseName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index < 0 ? trimmed : trimmed.slice(index + 1);
}

// ---------------------------------------------------------------- internals

function dirNode(path: string, name: string, expanded: boolean): TreeNode {
  return {
    path,
    name,
    kind: "dir",
    expanded,
    loaded: false,
    loading: false,
    children: [],
  };
}

function leafNode(entry: FsEntry): TreeNode {
  return {
    path: entry.path,
    name: entry.name,
    kind: entry.kind,
    size: entry.size,
    expanded: false,
    loaded: false,
    loading: false,
    children: [],
  };
}

/** Shallow-merge `changes` into the node at `path`, returning new state. */
function patch(
  state: TreeState,
  path: string,
  changes: Partial<TreeNode>,
): TreeState {
  const node = state.nodes[path];
  if (!node) return state;
  return { ...state, nodes: { ...state.nodes, [path]: { ...node, ...changes } } };
}

/** Whether `parent`'s currently-loaded children already match the freshly-read,
 * sorted `entries` exactly — same paths in the same order, each with the same
 * name, kind and size. If so, a re-read changed nothing. */
function sameListing(
  parent: TreeNode,
  sorted: FsEntry[],
  nodes: Record<string, TreeNode>,
): boolean {
  if (parent.children.length !== sorted.length) return false;
  return sorted.every((entry, index) => {
    if (parent.children[index] !== entry.path) return false;
    const node = nodes[entry.path];
    return (
      !!node &&
      node.name === entry.name &&
      node.kind === entry.kind &&
      node.size === entry.size
    );
  });
}

/** Delete a node and every descendant from `nodes` (mutating the given copy). */
function pruneSubtree(nodes: Record<string, TreeNode>, path: string): void {
  const node = nodes[path];
  if (!node) return;
  for (const child of node.children) pruneSubtree(nodes, child);
  delete nodes[path];
}
