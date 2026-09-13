import { useEffect, useRef, useState } from "react";
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
  // Whether a toggle has landed since the slot was asked. A person's toggle
  // outranks the slot's late answer: the answer is what was remembered
  // BEFORE the toggle, and applying it flipped the section back for a
  // moment — until the next mount read the toggle it had already saved.
  const touchedRef = useRef(false);

  useEffect(() => {
    // Torn down: the default, for whatever is left of this surface.
    const runtime = activeRuntime();
    if (!runtime) return;
    let cancelled = false;
    touchedRef.current = false;
    void runtime.storage
      .workspace(workspace)
      .get(KEY)
      .then((raw) => {
        if (!cancelled && !touchedRef.current) setState(readSections(raw));
      })
      .catch(() => {
        // An unreadable slot means the default — nothing to say.
      });
    return () => {
      cancelled = true;
    };
  }, [workspace.id, workspace.instance]);

  const toggle = (id: SectionId) => {
    touchedRef.current = true;
    const next = toggleSection(state, id);
    setState(next);
    // Torn down: nothing to remember it in.
    const runtime = activeRuntime();
    if (!runtime) return;
    void runtime.storage
      .workspace(workspace)
      .set(KEY, next)
      .catch((cause: unknown) => {
        // The screen keeps the toggle; the next mount will show the slot's
        // older word. Said in the log rather than swallowed — a UI and a
        // store that disagree should leave a trace somewhere.
        const message = cause instanceof Error ? cause.message : String(cause);
        runtime.log.warn(`git sections: could not remember the open sections: ${message}`);
      });
  };
  return [state, toggle];
}
