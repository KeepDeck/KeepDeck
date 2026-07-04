import type { ComponentType } from "react";
import { ExperimentsSection } from "./ExperimentsSection";
import { GeneralSection } from "./GeneralSection";
import { TerminalSection } from "./TerminalSection";

/** One page of the settings dialog ([F6]): a nav entry plus the panel it
 * shows. Sections read and write the settings store themselves — the dialog
 * shell only switches between them, so adding a setting never widens a
 * component contract, it just adds a row here (or a control to a section). */
export interface SettingsSection {
  id: string;
  label: string;
  Component: ComponentType;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: "general", label: "General", Component: GeneralSection },
  { id: "terminal", label: "Terminal", Component: TerminalSection },
  { id: "experiments", label: "Experiments", Component: ExperimentsSection },
];
