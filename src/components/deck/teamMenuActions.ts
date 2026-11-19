/**
 * A team menu's described lines, each bound to the act it owns — ONE
 * mapping, for the card's ⋯ and the team crumb's alike, so the two menus
 * cannot perform a line differently.
 */
import type { TeamMenuItem } from "../../presentation/teamMenuView";
import type { MenuAction } from "../../ui/MenuButton";

export interface TeamMenuActs {
  addMember(): void;
  rename(): void;
  resume(): void;
  suspend(): void;
  disband(): void;
  retry(): void;
}

export function teamMenuActions(items: readonly TeamMenuItem[], acts: TeamMenuActs): MenuAction[] {
  return items.map((item) => ({
    id: item.action,
    label: item.label,
    disabled: item.refusal !== null,
    refusal: item.refusal ?? undefined,
    onSelect: () => {
      switch (item.action) {
        case "add-member":
          return acts.addMember();
        case "rename":
          return acts.rename();
        case "resume":
          return acts.resume();
        case "suspend":
          return acts.suspend();
        case "disband":
          return acts.disband();
        case "retry":
          return acts.retry();
      }
    },
  }));
}
