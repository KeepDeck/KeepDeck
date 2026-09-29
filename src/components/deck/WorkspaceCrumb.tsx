import { MenuButton, type MenuAction } from "../../ui/MenuButton";
import { RenameInput } from "../../ui/RenameInput";
import { useInlineRename } from "../../ui/useInlineRename";
import {
  WORKSPACE_WORDS,
  workspaceMenuView,
  type ActiveWorkspace,
} from "../../presentation/stripView";

/** The crumb as the controller composes it and the bar passes it through. */
export interface WorkspaceCrumbProps {
  view: ActiveWorkspace;
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
export function WorkspaceCrumb({ view: workspace, onRename, onMove, onClose }: WorkspaceCrumbProps) {
  const rename = useInlineRename((_key, name) => onRename(name));
  const { name } = workspace;
  // Each described line → the callback it owns.
  const actions: MenuAction[] = workspaceMenuView(workspace).map((item, index) => {
    switch (item.kind) {
      case "rename":
        return { id: `${index}`, label: item.label, onSelect: () => rename.start(workspace.id, name) };
      case "move": {
        const to = item.to;
        return { id: `${index}`, label: item.label, disabled: to === null, onSelect: () => to !== null && onMove(to) };
      }
      case "close":
        return { id: `${index}`, label: item.label, onSelect: onClose };
    }
  });
  return (
    <div className="bar__group deck__ws">
      {rename.editing === workspace.id ? (
        <RenameInput rename={rename} className="deck__ws-rename" label={WORKSPACE_WORDS.renameField} />
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
