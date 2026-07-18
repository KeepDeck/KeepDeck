import { parseSkillFile, type SkillScope } from "../../domain/skills";
import type { StoredSkill } from "../../ipc/skills";

export interface SkillsNavGroup {
  label: string;
  scope: SkillScope;
  items: StoredSkill[];
}

interface SkillsNavProps {
  groups: SkillsNavGroup[];
  isActive(skill: StoredSkill): boolean;
  onOpen(skill: StoredSkill): void;
  onCreate(scope: SkillScope): void;
}

/** The library nav: scope groups of skill rows, each row answering "what
 * does this one do" with its description right under the name. */
export function SkillsNav({ groups, isActive, onOpen, onCreate }: SkillsNavProps) {
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
            const description = parseSkillFile(skill.content).description;
            return (
              <button
                key={`${skill.scope}:${skill.wsId ?? ""}:${skill.name}`}
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
              {scope.kind === "global"
                ? "Nothing here yet — a global skill reaches every workspace"
                : "Nothing here yet — these stay with this workspace"}
            </div>
          )}
        </div>
      ))}
    </nav>
  );
}
