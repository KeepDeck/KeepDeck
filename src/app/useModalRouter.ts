import { useState } from "react";
import { isStatsTab, type StatsTab } from "../domain/usage/statsTabs";

/**
 * THE owner of the app-surface dialog layer: which of the four exclusive
 * dialogs (settings, statistics, skills, artifacts) is open, and every verb that
 * opens, closes or retargets one. All entry points — toolbar, hotkey,
 * update banner, notification deep link, future command — speak these
 * verbs, so the gate ("one dialog at a time, never over a transaction")
 * and each open/close sequence live here once. A new dialog adds its flag
 * and verbs HERE instead of hand-assembling them at its call sites.
 *
 * Transactions (agent confirms, close flow, fork, the alert queue, the
 * frozen notice) are owned by their flows; the router only consumes the
 * fact that one is up. Close verbs no-op while it is: useEscape handlers
 * stack, so when an alert paints over a dialog, one Escape press would
 * otherwise dismiss the alert AND close the dialog underneath it. While a
 * transaction is up, Escape belongs to IT.
 */
export function useModalRouter({
  transactionOpen,
}: {
  transactionOpen: boolean;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<string | undefined>();
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [statsTab, setStatsTab] = useState<StatsTab>("overview");

  const anyDialogOpen =
    settingsOpen || statsOpen || skillsOpen || artifactsOpen;
  const canOpenDialog = !transactionOpen && !anyDialogOpen;

  const openSettings = (sectionId?: string): boolean => {
    if (!canOpenDialog) return false;
    setSettingsSection(sectionId);
    setSettingsOpen(true);
    return true;
  };
  const closeSettings = () => {
    if (transactionOpen) return;
    setSettingsOpen(false);
    setSettingsSection(undefined);
  };

  const openSkills = (): boolean => {
    if (!canOpenDialog) return false;
    setSkillsOpen(true);
    return true;
  };
  const closeSkills = () => {
    if (transactionOpen) return;
    setSkillsOpen(false);
  };

  const openArtifacts = (): boolean => {
    if (!canOpenDialog) return false;
    setArtifactsOpen(true);
    return true;
  };
  const closeArtifacts = () => {
    if (transactionOpen) return;
    setArtifactsOpen(false);
  };

  /** The Stats trio: a deep link arriving while the dialog is already open
   * switches tabs instead of being swallowed; closing resets to Overview. */
  const openStats = (tab?: StatsTab | null): boolean => {
    const next = isStatsTab(tab) ? tab : undefined;
    if (statsOpen) {
      if (next !== undefined) setStatsTab(next);
      return true;
    }
    if (!canOpenDialog) return false;
    setStatsTab(next ?? "overview");
    setStatsOpen(true);
    return true;
  };
  const closeStats = () => {
    if (transactionOpen) return;
    setStatsOpen(false);
    setStatsTab("overview");
  };
  /** The third verb of the sequence gets a function too — future tab-change
   * policy (analytics, prefetch) has a seam instead of a raw setter. */
  const selectStatsTab = (tab: StatsTab) => setStatsTab(tab);

  return {
    anyDialogOpen,
    canOpenDialog,
    /** Whether a dialog may close itself right now. Every close verb below
     * already refuses while a transaction is up; a dialog that owns an Escape
     * listener has to know BEFORE it cancels the press, or it swallows one it
     * will not act on. */
    canCloseDialog: !transactionOpen,
    settingsOpen,
    settingsSection,
    openSettings,
    closeSettings,
    skillsOpen,
    openSkills,
    closeSkills,
    artifactsOpen,
    openArtifacts,
    closeArtifacts,
    statsOpen,
    statsTab,
    openStats,
    closeStats,
    selectStatsTab,
  };
}
