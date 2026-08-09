import { useMemo } from "react";
import { skillDraftOf, type SkillScope } from "../../domain/skills";
import type { LibrarySkill } from "../../app/skillsLibrary";

export interface SkillsNavGroup {
  label: string;
  scope: SkillScope;
  items: LibrarySkill[];
}

interface SkillsNavProps {
  groups: SkillsNavGroup[];
  /** The library has not been read yet, so an empty group means "not known",
   * not "nothing here". */
  loading: boolean;
  isActive(skill: LibrarySkill): boolean;
  onOpen(skill: LibrarySkill): void;
  onCreate(scope: SkillScope): void;
}

/** The library nav: scope groups of skill rows, each row answering "what
 * does this one do" with its description right under the name. */
export function SkillsNav({
  groups,
  loading,
  isActive,
  onOpen,
  onCreate,
}: SkillsNavProps) {
  // Parsed once per list, not once per row per render: the projection reads the
  // whole SKILL.md — CRLF normalize, frontmatter scan, unscalar, body slice —
  // and every keystroke in the editor beside this nav re-rendered it.
  const described = useMemo(() => {
    const byRow = new Map<LibrarySkill, string>();
    for (const group of groups) {
      for (const skill of group.items) byRow.set(skill, skillDraftOf(skill).description);
    }
    return byRow;
  }, [groups]);

  return (
    <nav className="skills__nav" aria-label="Skills library">
      {groups.map(({ label, scope, items }) => (
        <div className="skills__group" key={scope.kind === "global" ? "global" : scope.wsId}>
          <div className="skills__group-head">
            <span className="skills__group-label">{label}</span>
            <button
              type="button"
              className="skills__new"
              onClick={() => onCreate(scope)}
              title={`New ${scope.kind === "global" ? "global" : "workspace"} skill`}
            >
              + New
            </button>
          </div>
          {items.map((skill) => {
            const description = described.get(skill);
            return (
              <button
                key={`${scope.kind === "global" ? "global" : scope.wsId}:${skill.name}`}
                type="button"
                className={`skills__item${isActive(skill) ? " skills__item--active" : ""}`}
                aria-current={isActive(skill) || undefined}
                onClick={() => onOpen(skill)}
              >
                <span className="skills__item-name">{skill.name}</span>
                {description && <span className="skills__item-desc">{description}</span>}
              </button>
            );
          })}
          {items.length === 0 && (
            <div className="skills__empty-group">
              {loading
                ? "Loading…"
                : scope.kind === "global"
                  ? "Nothing here yet — a global skill reaches every workspace"
                  : "Nothing here yet — these stay with this workspace"}
            </div>
          )}
        </div>
      ))}
    </nav>
  );
}
