import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { noAutoCorrect } from "../../ui/inputProps";
import { useInlineRename } from "../../ui/useInlineRename";
import { collectRailItemRects } from "../../app/railDnd";
import {
  animateElementReorder,
  animateFixedElementToRect,
  snapshotElementRects,
  usePointerDrag,
  type ElementRectSnapshot,
} from "../../app/dragManager";
import { railItemAtY } from "../../domain/deck";
import type { StatusFrame } from "../../domain/status";
import type { WorkspaceItem } from "../../presentation/railView";

export type { WorkspaceItem };

interface WorkspacesRailProps {
  workspaces: WorkspaceItem[];
  activeId: string;
  onSelect(id: string): void;
  onAdd(): void;
  onClose(id: string): void;
  onRename(id: string, name: string): void;
  /** Go into a team from its row: its workspace on screen, the team open. */
  onEnterTeam(wsId: string, teamId: string): void;
  /** Show or hide a workspace's teams under its name. */
  onToggleTeams(wsId: string): void;
  onRenameTeam(wsId: string, teamId: string, name: string): void;
  /** Move workspace `id` to `toIndex` (long-press drag reorder). */
  onReorder(id: string, toIndex: number): void;
  /** The running build, or null until `app_info` answers.
   *
   * Here rather than in the deck bar: a build number is read when something
   * has gone wrong and a report needs writing, which is a handful of times a
   * year — it has no business in the strip that answers what to do next. But
   * it also has no business being hidden behind a dialog, because the moment
   * it IS wanted, hunting for it is the last thing anyone wants to do. The
   * rail's own footer is the compromise: on screen, and out of the way. */
  version: string | null;
}

/**
 * The rail has two things to rename — a workspace and a team under it — and
 * ONE rename at a time. Namespacing the subject rather than running two
 * `useInlineRename`s makes that structural: `editing` is a single key, so
 * two names can never be under edit at once, and the drag suppression stays
 * one condition instead of two that must be remembered together.
 */
const workspaceKey = (wsId: string) => `ws:${wsId}`;
const teamKey = (wsId: string, teamId: string) => `team:${wsId}:${teamId}`;

/** Hold this long before a press turns into a reorder drag (vs. a select click). */
const LONG_PRESS_MS = 300;
/** Moving more than this before the hold arms cancels it — it wasn't a hold. */
const MOVE_CANCEL_PX = 10;
const REORDER_ANIMATION_MS = 140;

/** The dot's class for one frame — "none"/absent means the bare gray dot.
 * The item and its drag ghost share this: the ghost is the item's image,
 * so it wears the same frame. */
const railDotClass = (dot: StatusFrame | undefined) =>
  `rail__dot${!dot || dot === "none" ? "" : ` rail__dot--${dot}`}`;

interface DragSource {
  id: string;
  name: string;
  active: boolean;
  dot?: StatusFrame;
  grabOffsetY: number;
  rect: { left: number; top: number; width: number; height: number };
}

/** Snapshot of the item being dragged, used to render the floating ghost. */
interface DragGhost {
  id: string;
  name: string;
  active: boolean;
  dot?: StatusFrame;
  left: number;
  width: number;
  height: number;
  top: number;
}

/** Left rail listing workspaces with how many teams each holds. The active one is
 * highlighted and shows a × (also on hover); double-clicking a name renames it;
 * press-and-hold an item to drag it into a new position. */
export function WorkspacesRail({
  workspaces,
  activeId,
  onSelect,
  onAdd,
  onClose,
  onRename,
  onEnterTeam,
  onToggleTeams,
  onRenameTeam,
  onReorder,
  version,
}: WorkspacesRailProps) {
  // Empty commit = back to the auto name; both domain renames implement it.
  const rename = useInlineRename((key, name) => {
    const parts = key.split(":");
    if (parts[0] === "ws") onRename(parts[1], name);
    else onRenameTeam(parts[1], parts[2], name);
  });
  const [ghost, setGhost] = useState<DragGhost | null>(null);

  const listRef = useRef<HTMLUListElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const flipBefore = useRef<ElementRectSnapshot | null>(null);
  const cancelSettle = useRef<(() => void) | null>(null);

  // Position the ghost once when a drag begins (ghost identity is stable for the
  // whole drag); thereafter pointermove moves it directly via the ref, and since
  // `top` isn't in the JSX, list re-renders from reordering don't reset it.
  useLayoutEffect(() => {
    if (ghost && ghostRef.current) ghostRef.current.style.top = `${ghost.top}px`;
  }, [ghost]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !flipBefore.current) return;
    const before = flipBefore.current;
    flipBefore.current = null;
    animateElementReorder(railItemElements(list), railItemId, before, {
      durationMs: REORDER_ANIMATION_MS,
    });
  }, [workspaces]);

  useEffect(
    () => () => {
      cancelSettle.current?.();
      cancelSettle.current = null;
    },
    [],
  );

  const settleGhost = (id: string) => {
    const ghostEl = ghostRef.current;
    const slot = railItemElements(listRef.current).find((el) => railItemId(el) === id);
    if (!ghostEl || !slot) {
      setGhost(null);
      return;
    }
    const rect = railItemLayoutRect(listRef.current, slot);
    cancelSettle.current = animateFixedElementToRect(
      ghostEl,
      { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      {
        durationMs: REORDER_ANIMATION_MS,
        opacity: 0.65,
        transform: "scale(1)",
        onDone: () => {
          cancelSettle.current = null;
          setGhost(null);
        },
      },
    );
  };

  const drag = usePointerDrag<DragSource>({
    holdMs: LONG_PRESS_MS,
    cancelBeforeStartPx: MOVE_CANCEL_PX,
    onStart: ({ source }) => {
      cancelSettle.current?.();
      cancelSettle.current = null;
      setGhost({
        id: source.id,
        name: source.name,
        active: source.active,
        dot: source.dot,
        left: source.rect.left,
        width: source.rect.width,
        height: source.rect.height,
        top: source.rect.top,
      });
    },
    onMove: ({ source, current }) => {
      if (ghostRef.current) {
        ghostRef.current.style.top = `${current.y - source.grabOffsetY}px`;
      }
      const list = listRef.current;
      if (!list) return;
      const rects = collectRailItemRects(list);
      const overId = railItemAtY(current.y, rects);
      if (!overId || overId === source.id) return;
      const toIndex = rects.findIndex((r) => r.id === overId);
      if (toIndex < 0) return;
      flipBefore.current = snapshotElementRects(railItemElements(list), railItemId);
      onReorder(source.id, toIndex);
    },
    onDrop: ({ source }) => settleGhost(source.id),
    onCancel: () => setGhost(null),
  });

  const onItemPointerDown = (
    e: React.PointerEvent<HTMLLIElement>,
    ws: WorkspaceItem,
  ) => {
    // Primary button only; never start a drag from the ×, from a team row,
    // or while renaming. The team rows live INSIDE the workspace's item so
    // the hit-test column stays gapless — which puts them under this
    // handler too, where a 300ms press on a team would otherwise drag the
    // workspace out from under the finger that meant to open it.
    if (e.button !== 0 || rename.editing !== null) return;
    const from = e.target as HTMLElement;
    if (
      from.closest(".rail__close") ||
      from.closest(".rail__chevron") ||
      from.closest(".rail__teams")
    ) {
      return;
    }
    // The ghost is the workspace's own row, not the item: a drag of an
    // expanded workspace must not lift a block the height of its teams.
    const r = (
      e.currentTarget.querySelector(".rail__row") ?? e.currentTarget
    ).getBoundingClientRect();
    drag.startPointerDrag(e.nativeEvent, {
      id: ws.id,
      name: ws.name,
      active: ws.id === activeId,
      dot: ws.dot,
      grabOffsetY: e.clientY - r.top,
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
    });
  };

  return (
    <nav className="rail" aria-label="Workspaces">
      <div className="rail__head">
        <span className="rail__title">Workspaces</span>
        <button
          type="button"
          className="rail__add"
          onClick={onAdd}
          title="Add workspace"
          aria-label="Add workspace"
        >
          +
        </button>
      </div>
      <ul
        ref={listRef}
        className={`rail__list${ghost ? " rail__list--reordering" : ""}`}
      >
        {workspaces.map((ws) => {
          const active = ws.id === activeId;
          return (
            <li
              key={ws.id}
              data-ws-id={ws.id}
              className={`rail__item${active ? " rail__item--active" : ""}${
                ws.id === ghost?.id ? " rail__item--placeholder" : ""
              }`}
              onPointerDown={(e) => onItemPointerDown(e, ws)}
            >
              <div className="rail__row">
                {rename.editing === workspaceKey(ws.id) ? (
                  <input
                    {...noAutoCorrect}
                    {...rename.inputProps}
                    className="rail__rename"
                    autoFocus
                    aria-label="Workspace name"
                  />
                ) : (
                  <>
                    <button
                      type="button"
                      className={`rail__chevron${
                        ws.expanded ? " rail__chevron--open" : ""
                      }${ws.teams.length === 0 ? " rail__chevron--empty" : ""}`}
                      onClick={() => onToggleTeams(ws.id)}
                      disabled={ws.teams.length === 0}
                      aria-expanded={ws.expanded}
                      aria-label={
                        ws.expanded ? `Hide ${ws.name} teams` : `Show ${ws.name} teams`
                      }
                    >
                      {/* ONE glyph, turned by CSS. Two characters — a right
                          chevron and a down one — are drawn by the font at
                          different weights and on different baselines, so
                          they read as two marks swapping rather than as one
                          turning, and there is nothing between them to
                          animate. */}
                      <span className="rail__chevron-glyph" aria-hidden="true">
                        ›
                      </span>
                    </button>
                    <button
                      type="button"
                      className="rail__select"
                      onClick={() => onSelect(ws.id)}
                      onDoubleClick={() => rename.start(workspaceKey(ws.id), ws.name)}
                      aria-current={active}
                    >
                      <span className={railDotClass(ws.dot)} />
                      <span className="rail__name">{ws.name}</span>
                    </button>
                    {ws.teamCount > 0 && (
                      <span className="rail__count">{ws.teamCount}</span>
                    )}
                    <button
                      type="button"
                      className="rail__close"
                      onClick={() => onClose(ws.id)}
                      title="Close workspace"
                      aria-label={`Close ${ws.name}`}
                    >
                      ×
                    </button>
                  </>
                )}
              </div>
              {ws.expanded && (
                <ul className="rail__teams">
                  {ws.teams.map((team) => (
                    <li key={team.id}>
                      {rename.editing === teamKey(ws.id, team.id) ? (
                        <input
                          {...noAutoCorrect}
                          {...rename.inputProps}
                          className="rail__team-rename"
                          autoFocus
                          aria-label="Team name"
                        />
                      ) : (
                        <button
                          type="button"
                          className="rail__team"
                          onClick={() => onEnterTeam(ws.id, team.id)}
                          onDoubleClick={() =>
                            rename.start(teamKey(ws.id, team.id), team.name)
                          }
                        >
                          <span className={`rail__team-dot rail__team-dot--${team.dot}`} />
                          <span className="rail__team-name">{team.name}</span>
                          <span className="rail__team-size">{team.size}</span>
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      {version !== null && (
        <footer className="rail__foot" title={`KeepDeck ${version}`}>
          {version}
        </footer>
      )}

      {ghost &&
        createPortal(
          <div
            ref={ghostRef}
            className={`rail__ghost${ghost.active ? " rail__ghost--active" : ""}`}
            style={{ left: ghost.left, width: ghost.width, height: ghost.height }}
          >
            <span className={railDotClass(ghost.dot)} />
            <span className="rail__name">{ghost.name}</span>
          </div>,
          document.body,
        )}
    </nav>
  );
}

function railItemElements(list: HTMLElement | null): HTMLElement[] {
  if (!list) return [];
  return [...list.querySelectorAll<HTMLElement>("[data-ws-id]")];
}

function railItemId(element: HTMLElement): string {
  return element.dataset.wsId ?? "";
}

/** Where the dropped ghost settles: the workspace's own ROW inside the item,
 * never the item, whose height also covers however many teams are listed
 * under it — a ghost the size of the whole group is not the thing that was
 * picked up. The row's offsets are read directly and NOT added to the
 * item's: `offsetParent` skips static ancestors, and the list is the only
 * positioned one, so a row nested inside an item already measures from the
 * list — exactly as the item itself does for the hit-test. Nothing between
 * a row and the list may take a position, or both readings move at once. */
function railItemLayoutRect(list: HTMLElement | null, item: HTMLElement) {
  const listRect = list?.getBoundingClientRect();
  const row = item.querySelector<HTMLElement>(".rail__row") ?? item;
  return {
    left: (listRect?.left ?? 0) + row.offsetLeft - (list?.scrollLeft ?? 0),
    top: (listRect?.top ?? 0) + row.offsetTop - (list?.scrollTop ?? 0),
    width: row.offsetWidth,
    height: row.offsetHeight,
  };
}
