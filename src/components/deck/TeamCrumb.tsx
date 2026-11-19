import type { BarLevel } from "../../presentation/barView";
import { TEAM_MENU_WORDS } from "../../presentation/teamMenuView";
import { BranchBadge } from "../../ui/badges";
import { MenuButton } from "../../ui/MenuButton";
import { RenameInput } from "../../ui/RenameInput";
import { BAR_TIP_DELAY_MS } from "../../ui/TipButton";
import { Tooltip } from "../../ui/Tooltip";
import { useInlineRename } from "../../ui/useInlineRename";
import { teamMenuActions } from "./teamMenuActions";

/**
 * The bar's crumb for the team on screen: its name, the branch it works on,
 * and its ⋯ — the very lines its card's menu offers (`teamMenuView`),
 * performed through the same mapping, so the two cannot drift. A rename
 * from the menu (or a double-click, as on the card) edits the name where it
 * stands.
 */
export function TeamCrumb({
  name,
  branch,
  menu,
  onAddMember,
  onRename,
  onResume,
  onSuspend,
  onDisband,
  onRetry,
}: Extract<BarLevel, { kind: "team" }>) {
  // One crumb, one team: the key is constant, the caller keys the crumb.
  const rename = useInlineRename((_key, next) => onRename(next));
  const actions = teamMenuActions(menu, {
    addMember: onAddMember,
    rename: () => rename.start("team", name),
    resume: onResume,
    suspend: onSuspend,
    disband: onDisband,
    retry: onRetry,
  });
  return (
    <>
      {rename.editing === "team" ? (
        <RenameInput rename={rename} className="deck__crumb-rename" label={TEAM_MENU_WORDS.renameField} />
      ) : (
        // The app's own tip, not a `title`: the native one only comes after
        // the system's long delay (see TipButton), and an ellipsized team
        // name must be quick to recover.
        <Tooltip tip={name} delayMs={BAR_TIP_DELAY_MS}>
          <span
            className="deck__team-name"
            aria-current="page"
            onDoubleClick={() => rename.start("team", name)}
          >
            {name}
          </span>
        </Tooltip>
      )}
      {branch !== null && (
        <BranchBadge className="deck__team-branch" size="sm" label={branch} title={branch} />
      )}
      <MenuButton
        variant="ghost"
        size="sm"
        className="deck__team-menu"
        actions={actions}
        ariaLabel={TEAM_MENU_WORDS.ariaLabel(name)}
      >
        ⋯
      </MenuButton>
    </>
  );
}
