/**
 * Shared agent skills — the SKILL.md library authored inside KeepDeck and
 * distributed to every CLI at spawn time (storage and staging live behind
 * `src/ipc/skills.ts`).
 *
 * `skills.ts` holds the rules — scope, naming and description verdicts.
 * The codec that reads and writes the file is the plugin contract's
 * (`@keepdeck/plugin-api`); `skillFile.ts` applies the library's own rule to
 * its reading.
 */
export * from "./skills";
export { skillDraftOf } from "./skillFile";
export {
  composeSkillFile,
  frontmatterObstacle,
  frontmatterTextOf,
  normalizeSkillDescription,
  renameSkillFile,
  type SkillDraft,
  type SkillFileRename,
} from "@keepdeck/plugin-api";
// `parseSkillFile` is deliberately NOT re-exported: `skillDraftOf` is the reading
// every surface wants, because it applies "the directory name wins over the
// frontmatter's". The raw parse, with its nullable name, is the codec's own
// business and its suite's.
