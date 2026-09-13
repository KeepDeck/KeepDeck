import { useEffect, useState } from "react";
import type { WorkspaceRef } from "@keepdeck/plugin-api";
import { activeRuntime } from "../runtime";
import {
  DEFAULT_SECTIONS,
  readSections,
  toggleSection,
  type SectionId,
  type SectionsState,
} from "../presentation/sections";

const KEY = "sections";

/**
 * The tab's open sections, remembered per workspace in the plugin's
 * workspace slot. Loads once per workspace lifetime — the default shows
 * until the slot answers — and writes on every toggle. The rule of what a
 * toggle does lives in `presentation/sections`; this is the wiring to a
 * component's lifetime and to storage.
 */
export function useSections(
  workspace: WorkspaceRef,
): [state: SectionsState, toggle: (id: SectionId) => void] {
  const [state, setState] = useState<SectionsState>(DEFAULT_SECTIONS);

  useEffect(() => {
    // Torn down: the default, for whatever is left of this surface.
    const runtime = activeRuntime();
    if (!runtime) return;
    let cancelled = false;
    void runtime.storage
      .workspace(workspace)
      .get(KEY)
      .then((raw) => {
        if (!cancelled) setState(readSections(raw));
      })
      .catch(() => {
        // An unreadable slot means the default — nothing to say.
      });
    return () => {
      cancelled = true;
    };
  }, [workspace.id, workspace.instance]);

  const toggle = (id: SectionId) => {
    const next = toggleSection(state, id);
    setState(next);
    // Torn down: nothing to remember it in.
    void activeRuntime()?.storage.workspace(workspace).set(KEY, next).catch(() => {});
  };
  return [state, toggle];
}
