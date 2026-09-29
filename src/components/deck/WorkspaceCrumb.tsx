import { MenuButton, type MenuAction } from "../../ui/MenuButton";
import { RenameInput } from "../../ui/RenameInput";
import { useInlineRename } from "../../ui/useInlineRename";
import {
  WORKSPACE_WORDS,
  workspaceMenuView,
  type WorkspaceCrumbView,
} from "../../presentation/workspaceCrumbView";


/**
 * The first crumb of the bar: the workspace on screen — the strip's marks
 * say only its initials — and the one menu that acts on it: rename, move
 * up or down the column (the keyboard's way to do what dragging a mark
 * does), close. Inside a team the name is also the way back up to the
 * workspace's team cards, as a breadcrumb's parent is.
 */
export function WorkspaceCrumb({
  view: workspace,
  onRename,
  onMove,
  onClose,
  onUp,
}: WorkspaceCrumbView) {
  const rename = useInlineRename((_key, name) => onRename(name));
  const { name } = workspace;
  // Each described line → the callback it owns. A refused move is never
  // selected (the menu disables it), so it has nowhere to go.
  const actions: MenuAction[] = workspaceMenuView(workspace).map((item) => ({
    id: item.id,
    label: item.label,
    disabled: item.disabled,
    onSelect: () => {
      if (item.kind === "rename") rename.start(workspace.id, name);
      else if (item.kind === "close") onClose();
      else if (item.to !== null) onMove(item.to);
    },
  }));
  return (
    <span className="deck__ws">
      {rename.editing === workspace.id ? (
        <RenameInput rename={rename} className="deck__ws-rename" label={WORKSPACE_WORDS.renameField} />
      ) : onUp ? (
        <button
          type="button"
          className="deck__ws-name deck__ws-name--up"
          onClick={onUp}
          aria-label={WORKSPACE_WORDS.up(name)}
          title={WORKSPACE_WORDS.up(name)}
        >
          {name}
        </button>
      ) : (
        // At the cards the name is only a name, so a double-click renames it
        // as it does a team card's; inside a team it is a link, and a
        // double-click would first leave the team.
        <span
          className="deck__ws-name"
          title={name}
          onDoubleClick={() => rename.start(workspace.id, name)}
        >
          {name}
        </span>
      )}
      <MenuButton
        variant="ghost"
        size="sm"
        className="deck__ws-menu"
        actions={actions}
        ariaLabel={WORKSPACE_WORDS.menu(name)}
      >
        ⋯
      </MenuButton>
    </span>
  );
}
