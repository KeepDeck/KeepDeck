import {
  skillDraftOf,
  skillScopeKey,
  type SkillLibraryScope,
  type SkillScope,
} from "../../domain/skills";
import type { LibrarySkill } from "../../app/skillsLibrary";
import { LibraryNav, type LibraryNavCopy, type LibraryNavGroup } from "../library/LibraryNav";

export type SkillsNavGroup = LibraryNavGroup<SkillScope, SkillLibraryScope, LibrarySkill>;

/** What the skills nav says — the words, apart from the component that lays
 * them out. The description under a row is read through the same projection
 * every other surface uses, so the nav and the editor see one skill. */
export const SKILLS_NAV_COPY: LibraryNavCopy<SkillScope, SkillLibraryScope, LibrarySkill> = {
  ariaLabel: "Skills library",
  scopeKey: skillScopeKey,
  describe: (skill) => skillDraftOf(skill).description || undefined,
  // The KIND of library, not which one — a different question from the
  // group's own label, which names it. Kept deliberately generic: "New site
  // skill" reads worse than "New workspace skill".
  createTitle: (scope) => `New ${scope.kind === "global" ? "global" : "workspace"} skill`,
  emptyCopy: (scope) =>
    scope.kind === "bundled"
      ? "Bundled skills ship with KeepDeck — create your own in Global and copy any part"
      : scope.kind === "global"
        ? "Nothing here yet — a global skill reaches every workspace"
        : "Nothing here yet — these stay with this workspace",
};

interface SkillsNavProps {
  groups: SkillsNavGroup[];
  emptyMeans: "loading" | "unknown" | "empty";
  busy: boolean;
  isActive(skill: LibrarySkill): boolean;
  onOpen(skill: LibrarySkill): void;
  onCreate(scope: SkillLibraryScope): void;
}

/** The skills library nav — the shared nav under the skills copy. */
export function SkillsNav(props: SkillsNavProps) {
  return <LibraryNav copy={SKILLS_NAV_COPY} {...props} />;
}
