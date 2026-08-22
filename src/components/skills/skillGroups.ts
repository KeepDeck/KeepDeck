/**
 * The library's scope groups — which rows the nav shows, under which
 * heading, in which order.
 *
 * A pure function of the listed library and the active workspace: no
 * React, no store, nothing to mock. It lives beside the nav it feeds
 * rather than inside the dialog because the ORDER is a rule about the
 * library (user content outranks app content), not about the dialog that
 * happens to render it.
 */
import { sameSkillScope, type SkillScope } from "../../domain/skills";
import type { LibrarySkill } from "../../app/skillsLibrary";
import type { SkillsNavGroup } from "./SkillsNav";

/** The workspace a "This workspace" group would belong to; `null` (no
 * workspace yet) leaves only the global scope. */
export interface GroupWorkspace {
  id: string;
  name: string;
}

/**
 * Build the nav's groups: Global, the active workspace when there is
 * one, then Bundled.
 *
 * Membership goes through the domain predicate, like every other scope
 * test — a raw field comparison here would silently stop agreeing with
 * them the moment a scope means anything new.
 */
export function buildSkillGroups(
  skills: LibrarySkill[] | null,
  activeWs: GroupWorkspace | null,
): SkillsNavGroup[] {
  const all = skills ?? [];
  const built: SkillsNavGroup[] = [
    {
      label: "Global",
      scope: { kind: "global" },
      items: all.filter((s) => sameSkillScope(s.scope, { kind: "global" })),
    },
  ];
  if (activeWs) {
    const scope: SkillScope = { kind: "workspace", wsId: activeWs.id };
    built.push({
      label: activeWs.name,
      scope,
      items: all.filter((s) => sameSkillScope(s.scope, scope)),
    });
  }
  // The bundled tier LAST (user content outranks app content on the
  // user's machine) — rows render from the list, both a user-global and
  // the bundled same-name row visible side by side (namespaces at rest;
  // resolution-by-name lives in staging alone).
  const bundled = all.filter((s) => s.scope.kind === "bundled");
  if (bundled.length > 0) {
    built.push({
      label: "Bundled",
      scope: { kind: "bundled" },
      items: bundled,
    });
  }
  return built;
}

/**
 * The heading a scope is shown under.
 *
 * From the GROUPS, which pair each scope with its name — the one place
 * that knows which workspace a scope belongs to. Re-deriving the label
 * from the active workspace answers a different question ("what is the
 * active workspace called") and so stamps its name on any scope but its
 * own: the editor can outlive the switch that changed it, and the chip
 * is the only thing on screen saying which library a save lands in.
 */
export function labelForScope(
  groups: SkillsNavGroup[],
  scope: SkillScope,
): string {
  return (
    groups.find((group) => sameSkillScope(group.scope, scope))?.label ??
    "Workspace"
  );
}
