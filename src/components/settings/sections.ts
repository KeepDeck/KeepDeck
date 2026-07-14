import type { ComponentType } from "react";
import { GeneralSection } from "./GeneralSection";
import { NotificationsSection } from "./NotificationsSection";
import { TerminalSection } from "./TerminalSection";
import { UpdatesSection } from "./UpdatesSection";

/** One page of the settings dialog ([F6]): a nav entry plus the panel it
 * shows. Sections read and write the settings store themselves — the dialog
 * shell only switches between them, so adding a setting never widens a
 * component contract, it just adds a row here (or a control to a section).
 * Plugins are NOT listed here: each installed plugin is its own dynamic nav
 * section (see SettingsDialog) — there is no all-plugins page. */
export interface SettingsSection {
  id: string;
  label: string;
  Component: ComponentType;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: "general", label: "General", Component: GeneralSection },
  { id: "terminal", label: "Terminal", Component: TerminalSection },
  { id: "notifications", label: "Notifications", Component: NotificationsSection },
  { id: "updates", label: "Updates", Component: UpdatesSection },
];
