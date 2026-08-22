import { useMemo } from "react";
import { skillDraftOf, skillScopeKey, type SkillScope } from "../../domain/skills";
import type { LibrarySkill } from "../../app/skillsLibrary";

export interface SkillsNavGroup {
  label: string;
  scope: SkillScope;
  items: LibrarySkill[];
}

interface SkillsNavProps {
  groups: SkillsNavGroup[];
  /** What an EMPTY group means right now. "unknown" covers both the first read
   * and a read that FAILED — with only a loading flag, a failed read let the nav
   * assert "Nothing here yet" beside a placeholder saying the library could not be
   * read, and a user who believed the nav created a skill that already existed. */
  emptyMeans: "loading" | "unknown" | "empty";
  /** A write is in flight. Rows go quiet with the editor's buttons: navigating
   * mid-delete bumped the epoch that the delete's own completion checks, so the
   * editor was left on a skill that no longer existed with no row to correct it
   * with. */
  busy: boolean;
  isActive(skill: LibrarySkill): boolean;
  onOpen(skill: LibrarySkill): void;
  onCreate(scope: SkillScope): void;
}

/** The library nav: scope groups of skill rows, each row answering "what
 * does this one do" with its description right under the name. */
export function SkillsNav({
  groups,
  emptyMeans,
  busy,
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
        <div className="skills__group" key={skillScopeKey(scope)}>
          <div className="skills__group-head">
            <span className="skills__group-label">{label}</span>
            {scope.kind !== "bundled" && (
              <button
                type="button"
                className="skills__new"
                onClick={() => onCreate(scope)}
                disabled={busy}
                // The KIND of library, not which one — a different question from the
                // group's own label, which names it. Kept deliberately generic:
                // "New site skill" reads worse than "New workspace skill".
                title={`New ${scope.kind === "global" ? "global" : "workspace"} skill`}
              >
                + New
              </button>
            )}
          </div>
          {items.map((skill) => {
            const description = described.get(skill);
            return (
              <button
                key={`${skillScopeKey(scope)}:${skill.name}`}
                type="button"
                className={`skills__item${isActive(skill) ? " skills__item--active" : ""}`}
                aria-current={isActive(skill) || undefined}
                disabled={busy}
                onClick={() => onOpen(skill)}
              >
                <span className="skills__item-name">{skill.name}</span>
                {description && <span className="skills__item-desc">{description}</span>}
              </button>
            );
          })}
          {items.length === 0 && (
            <div className="skills__empty-group">
              {emptyMeans === "loading"
                ? "Loading…"
                : emptyMeans === "unknown"
                  ? "Not known — see the message above"
                  : scope.kind === "bundled"
                    ? "Bundled skills ship with KeepDeck — create your own in Global and copy any part"
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
