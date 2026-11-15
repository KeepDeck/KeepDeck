/**
 * A workspace menu's described lines, each bound to the act it owns — ONE
 * mapping, for the crumb's ⋯ and a mark's right-click alike, so the two
 * menus cannot perform a line differently.
 */
import type { WorkspacePlace } from "../../domain/deck";
import type { WorkspaceMenuItem } from "../../presentation/workspaceCrumbView";
import type { MenuAction } from "../../ui/MenuButton";

export interface WorkspaceMenuActs {
  rename(): void;
  move(place: WorkspacePlace): void;
  archive(): void;
  close(): void;
}

export function workspaceMenuActions(items: readonly WorkspaceMenuItem[], acts: WorkspaceMenuActs): MenuAction[] {
  return items.map((item) => ({
    id: item.id,
    label: item.label,
    disabled: item.disabled,
    separatorBefore: item.separatorBefore,
    onSelect: () => {
      switch (item.kind) {
        case "rename":
          return acts.rename();
        case "archive":
          return acts.archive();
        case "close":
          return acts.close();
        case "move":
          // A refused move is never selected — the menu disables it.
          if (item.place !== null) acts.move(item.place);
          return;
      }
    },
  }));
}
