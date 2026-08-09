/**
 * The Tauri side of the skills library, as the library's own port.
 *
 * Its own module in `src/ipc` rather than inside `skillsLibrary.ts`, which
 * DECLARES the port: the module that owns the rules should not also be the only
 * place the wire is decoded, and having both there made `src/app` import
 * `src/ipc` and made the file's job need two sentences.
 *
 * `fetch` is the one verb that is not a bare re-export. It reads the DTO's two
 * scope columns into one `SkillScope`, which is where the wire's shape stops:
 * `StoredSkill` mirrors the Rust struct field for field, and letting it upward
 * made it the currency of the library's public `list`, the editor's state, both
 * views and a React key — four layers a backend rename would reach.
 */
import { skillScopeOf } from "../domain/skills";
import type { SkillsStorage } from "../app/skillsLibrary";
import { deleteSkill, fetchSkills, renameSkill, saveSkill } from "./skills";

export const ipcSkillsStorage: SkillsStorage = {
  fetch: async () =>
    (await fetchSkills()).map((row) => ({
      scope: skillScopeOf(row),
      name: row.name,
      content: row.content,
    })),
  save: saveSkill,
  rename: renameSkill,
  remove: deleteSkill,
};
