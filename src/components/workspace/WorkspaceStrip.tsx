import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { noAutoCorrect } from "../../ui/inputProps";
import { useInlineRename } from "../../ui/useInlineRename";
import { MenuButton, type MenuAction } from "../../ui/MenuButton";
import { collectRailItemRects } from "../../app/railDnd";
import { SidebarIcon } from "../AppIcons";
import {
  animateElementReorder,
  animateFixedElementToRect,
  snapshotElementRects,
  usePointerDrag,
  type ElementRectSnapshot,
} from "../../app/dragManager";
import { railItemAtY } from "../../domain/deck";
import {
  STRIP_WORDS,
  type StripView,
  type TeamList,
  type WorkspaceMark,
} from "../../presentation/stripView";
import { TEAM_WORDS, type TeamAction } from "../../presentation/teamView";

interface WorkspaceStripProps {
  view: StripView;
  /** Whether the open workspace's team list shows beside the marks. */
  teamsShown: boolean;
  onToggleTeams(): void;
  onSelect(id: string): void;
  onAdd(): void;
  onClose(id: string): void;
  onRename(id: string, name: string): void;
  /** Move workspace `id` to `toIndex` (long-press drag reorder). */
  onReorder(id: string, toIndex: number): void;
  /** Put a team on the stage. */
  onEnterTeam(wsId: string, teamId: string): void;
  onRenameTeam(wsId: string, teamId: string, name: string): void;
  /** A team action other than rename, which the strip does in place. */
  onTeamAction(wsId: string, teamId: string, action: Exclude<TeamAction, "rename">): void;
  /** Start a team in the open workspace, or null while none can be. */
  onAddTeam: (() => void) | null;
  /** The running build, or null until `app_info` answers. At the strip's
   * foot: read a few times a year, when a report needs writing — on screen,
   * and out of the way. */
  version: string | null;
}

/**
 * The strip has two things to rename — the open workspace and a team in it
 * — and ONE rename at a time: `editing` is a single namespaced key, so two
 * names can never be under edit at once.
 */
const workspaceKey = (wsId: string) => `ws:${wsId}`;
const teamKey = (wsId: string, teamId: string) => `team:${wsId}:${teamId}`;

/** Hold this long before a press turns into a reorder drag (vs. a select click). */
const LONG_PRESS_MS = 300;
/** Moving more than this before the hold arms cancels it — it wasn't a hold. */
const MOVE_CANCEL_PX = 10;
const REORDER_ANIMATION_MS = 140;

interface DragSource {
  mark: WorkspaceMark;
  grabOffsetY: number;
  rect: { left: number; top: number; width: number; height: number };
}

/** Snapshot of the mark being dragged, used to render the floating ghost. */
interface DragGhost {
  mark: WorkspaceMark;
  left: number;
  width: number;
  height: number;
  top: number;
}

/**
 * The left strip: a column of workspace marks — «+» pinned on top, the
 * marks under it (press-and-hold one to drag it to a new place), the build
 * at the foot — and beside it, unless hidden, the open workspace's teams.
 */
export function WorkspaceStrip({
  view,
  teamsShown,
  onToggleTeams,
  onSelect,
  onAdd,
  onClose,
  onRename,
  onReorder,
  onEnterTeam,
  onRenameTeam,
  onTeamAction,
  onAddTeam,
  version,
}: WorkspaceStripProps) {
  // Empty commit = back to the auto name; both domain renames implement it.
  const rename = useInlineRename((key, name) => {
    const parts = key.split(":");
    if (parts[0] === "ws") onRename(parts[1], name);
    else onRenameTeam(parts[1], parts[2], name);
  });
  const [ghost, setGhost] = useState<DragGhost | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const flipBefore = useRef<ElementRectSnapshot | null>(null);
  const cancelSettle = useRef<(() => void) | null>(null);

  // Position the ghost once when a drag begins; thereafter pointermove moves
  // it directly via the ref, so list re-renders from reordering never reset it.
  useLayoutEffect(() => {
    if (ghost && ghostRef.current) ghostRef.current.style.top = `${ghost.top}px`;
  }, [ghost]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !flipBefore.current) return;
    const before = flipBefore.current;
    flipBefore.current = null;
    animateElementReorder(markElements(list), markId, before, {
      durationMs: REORDER_ANIMATION_MS,
    });
  }, [view.marks]);

  useEffect(
    () => () => {
      cancelSettle.current?.();
      cancelSettle.current = null;
    },
    [],
  );

  const settleGhost = (id: string) => {
    const ghostEl = ghostRef.current;
    const slot = markElements(listRef.current).find((el) => markId(el) === id);
    if (!ghostEl || !slot) {
      setGhost(null);
      return;
    }
    const rect = markLayoutRect(listRef.current, slot);
    cancelSettle.current = animateFixedElementToRect(ghostEl, rect, {
      durationMs: REORDER_ANIMATION_MS,
      opacity: 0.65,
      transform: "scale(1)",
      onDone: () => {
        cancelSettle.current = null;
        setGhost(null);
      },
    });
  };

  const drag = usePointerDrag<DragSource>({
    holdMs: LONG_PRESS_MS,
    cancelBeforeStartPx: MOVE_CANCEL_PX,
    onStart: ({ source }) => {
      cancelSettle.current?.();
      cancelSettle.current = null;
      setGhost({ mark: source.mark, ...source.rect });
    },
    onMove: ({ source, current }) => {
      if (ghostRef.current) {
        ghostRef.current.style.top = `${current.y - source.grabOffsetY}px`;
      }
      const list = listRef.current;
      if (!list) return;
      const rects = collectRailItemRects(list);
      const overId = railItemAtY(current.y, rects);
      if (!overId || overId === source.mark.id) return;
      const toIndex = rects.findIndex((r) => r.id === overId);
      if (toIndex < 0) return;
      flipBefore.current = snapshotElementRects(markElements(list), markId);
      onReorder(source.mark.id, toIndex);
    },
    onDrop: ({ source }) => settleGhost(source.mark.id),
    onCancel: () => setGhost(null),
  });

  const onMarkPointerDown = (e: React.PointerEvent<HTMLButtonElement>, mark: WorkspaceMark) => {
    if (e.button !== 0 || rename.editing !== null) return;
    const r = e.currentTarget.getBoundingClientRect();
    drag.startPointerDrag(e.nativeEvent, {
      mark,
      grabOffsetY: e.clientY - r.top,
      rect: { left: r.left, top: r.top, width: r.width, height: r.height },
    });
  };

  return (
    <nav className={`strip${teamsShown ? "" : " strip--marks-only"}`} aria-label="Workspaces">
      <div className="strip__col">
        <button
          type="button"
          className="strip__mark strip__mark--add"
          onClick={onAdd}
          aria-label={STRIP_WORDS.addWorkspace}
          title={STRIP_WORDS.addWorkspace}
        >
          <span className="strip__tile" aria-hidden>
            +
          </span>
        </button>
        <div
          ref={listRef}
          className={`strip__marks${ghost ? " strip__marks--reordering" : ""}`}
        >
          {view.marks.map((mark) => (
            <button
              key={mark.id}
              type="button"
              data-ws-id={mark.id}
              className={`strip__mark${mark.active ? " strip__mark--active" : ""}${
                mark.id === ghost?.mark.id ? " strip__mark--placeholder" : ""
              }`}
              onClick={() => onSelect(mark.id)}
              onPointerDown={(e) => onMarkPointerDown(e, mark)}
              aria-current={mark.active}
              aria-label={mark.label}
              title={mark.label}
            >
              <MarkFace mark={mark} />
            </button>
          ))}
        </div>
        {version !== null && (
          <footer className="strip__foot" title={`KeepDeck ${version}`}>
            {version}
          </footer>
        )}
      </div>

      {teamsShown && view.teams && (
        <TeamListPane
          list={view.teams}
          rename={rename}
          onToggleTeams={onToggleTeams}
          onClose={onClose}
          onReorder={onReorder}
          onEnterTeam={onEnterTeam}
          onTeamAction={onTeamAction}
          onAddTeam={onAddTeam}
        />
      )}

      {ghost &&
        createPortal(
          <div
            ref={ghostRef}
            className="strip__ghost"
            style={{ left: ghost.left, width: ghost.width, height: ghost.height }}
          >
            <MarkFace mark={ghost.mark} />
          </div>,
          document.body,
        )}
    </nav>
  );
}

/** A mark's face — the tile with its letters and dot, the name under it.
 * The mark and its drag ghost share it: the ghost is the mark's image. */
function MarkFace({ mark }: { mark: WorkspaceMark }) {
  return (
    <>
      <span className="strip__tile" aria-hidden>
        {mark.initials}
        {mark.dot && <span className={`strip__dot strip__dot--${mark.dot}`} />}
      </span>
      <span className="strip__name" aria-hidden>
        {mark.name}
      </span>
    </>
  );
}

function TeamListPane({
  list,
  rename,
  onToggleTeams,
  onClose,
  onReorder,
  onEnterTeam,
  onTeamAction,
  onAddTeam,
}: {
  list: TeamList;
  rename: ReturnType<typeof useInlineRename>;
  onToggleTeams(): void;
  onClose(id: string): void;
  onReorder(id: string, toIndex: number): void;
  onEnterTeam(wsId: string, teamId: string): void;
  onTeamAction(wsId: string, teamId: string, action: Exclude<TeamAction, "rename">): void;
  onAddTeam: (() => void) | null;
}) {
  const { wsId, wsName, rows, moveUpTo, moveDownTo } = list;
  const workspaceActions: MenuAction[] = [
    {
      id: "rename",
      label: STRIP_WORDS.renameWorkspace,
      onSelect: () => rename.start(workspaceKey(wsId), wsName),
    },
    // The keyboard's way to do what holding a mark and dragging it does.
    {
      id: "up",
      label: STRIP_WORDS.moveUp,
      disabled: moveUpTo === null,
      onSelect: () => moveUpTo !== null && onReorder(wsId, moveUpTo),
    },
    {
      id: "down",
      label: STRIP_WORDS.moveDown,
      disabled: moveDownTo === null,
      onSelect: () => moveDownTo !== null && onReorder(wsId, moveDownTo),
    },
    { id: "close", label: STRIP_WORDS.closeWorkspace, onSelect: () => onClose(wsId) },
  ];
  return (
    <div className="strip__teams">
      <div className="strip__head">
        {rename.editing === workspaceKey(wsId) ? (
          <input
            {...noAutoCorrect}
            {...rename.inputProps}
            className="strip__rename"
            autoFocus
            aria-label={STRIP_WORDS.renameField}
          />
        ) : (
          <span
            className="strip__ws-name"
            title={wsName}
            onDoubleClick={() => rename.start(workspaceKey(wsId), wsName)}
          >
            {wsName}
          </span>
        )}
        <MenuButton
          variant="ghost"
          size="sm"
          className="strip__icon"
          actions={workspaceActions}
          ariaLabel={STRIP_WORDS.workspaceMenu(wsName)}
        >
          ⋯
        </MenuButton>
        {onAddTeam && (
          <button
            type="button"
            className="strip__icon"
            onClick={onAddTeam}
            aria-label={STRIP_WORDS.addTeam}
            title={STRIP_WORDS.addTeam}
          >
            +
          </button>
        )}
        <button
          type="button"
          className="strip__icon"
          onClick={onToggleTeams}
          aria-label={STRIP_WORDS.hideTeams}
          title={STRIP_WORDS.hideTeams}
        >
          <SidebarIcon />
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="strip__empty">{STRIP_WORDS.noTeams}</div>
      ) : (
        <ul className="strip__list" aria-label="Teams">
          {rows.map((row) => (
            <li
              key={row.id}
              className={`strip__team${row.open ? " strip__team--open" : ""}${
                row.pending ? " strip__team--pending" : ""
              }`}
            >
              {rename.editing === teamKey(wsId, row.id) ? (
                <input
                  {...noAutoCorrect}
                  {...rename.inputProps}
                  className="strip__rename"
                  autoFocus
                  aria-label={TEAM_WORDS.renameField}
                />
              ) : (
                <>
                  <button
                    type="button"
                    className="strip__team-open"
                    onClick={() => onEnterTeam(wsId, row.id)}
                    onDoubleClick={() => rename.start(teamKey(wsId, row.id), row.name)}
                    aria-current={row.open}
                  >
                    <span className="strip__team-name">{row.name}</span>
                    {row.dot && <span className={`strip__dot strip__dot--${row.dot}`} />}
                    <span className="strip__team-size">{row.size}</span>
                  </button>
                  <MenuButton
                    variant="ghost"
                    size="sm"
                    className="strip__team-menu"
                    ariaLabel={TEAM_WORDS.menu(row.name)}
                    actions={row.actions.map((action) => ({
                      id: action,
                      label: TEAM_WORDS.action[action],
                      onSelect: () =>
                        action === "rename"
                          ? rename.start(teamKey(wsId, row.id), row.name)
                          : onTeamAction(wsId, row.id, action),
                    }))}
                  >
                    ⋯
                  </MenuButton>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function markElements(list: HTMLElement | null): HTMLElement[] {
  if (!list) return [];
  return [...list.querySelectorAll<HTMLElement>("[data-ws-id]")];
}

function markId(element: HTMLElement): string {
  return element.dataset.wsId ?? "";
}

/** Where the dropped ghost settles: the mark's layout box, measured through
 * the list (its only positioned ancestor), untouched by FLIP transforms. */
function markLayoutRect(list: HTMLElement | null, mark: HTMLElement) {
  const listRect = list?.getBoundingClientRect();
  return {
    left: (listRect?.left ?? 0) + mark.offsetLeft - (list?.scrollLeft ?? 0),
    top: (listRect?.top ?? 0) + mark.offsetTop - (list?.scrollTop ?? 0),
    width: mark.offsetWidth,
    height: mark.offsetHeight,
  };
}
