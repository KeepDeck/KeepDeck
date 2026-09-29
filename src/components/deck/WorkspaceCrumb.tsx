import { MenuButton, type MenuAction } from "../../ui/MenuButton";
import { noAutoCorrect } from "../../ui/inputProps";
import { useInlineRename } from "../../ui/useInlineRename";
import { WORKSPACE_WORDS, type ActiveWorkspace } from "../../presentation/stripView";

interface WorkspaceCrumbProps {
  workspace: ActiveWorkspace;
  /** Empty = back to the auto name, which the domain rename implements. */
  onRename(name: string): void;
  /** Move the workspace to `toIndex` in the strip's column. */
  onMove(toIndex: number): void;
  onClose(): void;
}

/**
 * The workspace on screen, named at the start of the bar — the strip's
 * marks say only its initials — with the one menu that acts on it: rename
 * (also a double-click on the name), move up or down the column (the
 * keyboard's way to do what dragging a mark does), close.
 */
export function WorkspaceCrumb({ workspace, onRename, onMove, onClose }: WorkspaceCrumbProps) {
  const rename = useInlineRename((_key, name) => onRename(name));
  const { name, moveUpTo, moveDownTo } = workspace;
  const actions: MenuAction[] = [
    { id: "rename", label: WORKSPACE_WORDS.rename, onSelect: () => rename.start(workspace.id, name) },
    {
      id: "up",
      label: WORKSPACE_WORDS.moveUp,
      disabled: moveUpTo === null,
      onSelect: () => moveUpTo !== null && onMove(moveUpTo),
    },
    {
      id: "down",
      label: WORKSPACE_WORDS.moveDown,
      disabled: moveDownTo === null,
      onSelect: () => moveDownTo !== null && onMove(moveDownTo),
    },
    { id: "close", label: WORKSPACE_WORDS.close, onSelect: onClose },
  ];
  return (
    <div className="bar__group deck__ws">
      {rename.editing === workspace.id ? (
        <input
          {...noAutoCorrect}
          {...rename.inputProps}
          className="deck__ws-rename"
          autoFocus
          aria-label={WORKSPACE_WORDS.renameField}
        />
      ) : (
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
    </div>
  );
}
