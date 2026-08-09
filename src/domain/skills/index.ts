/**
 * Shared agent skills — the SKILL.md library authored inside KeepDeck and
 * distributed to every CLI at spawn time (storage and staging live behind
 * `src/ipc/skills.ts`).
 *
 * `skills.ts` holds the rules — scope, draft, naming and description verdicts.
 * `skillFile.ts` holds the codec that reads and writes the file.
 */
export * from "./skills";
export {
  composeSkillFile,
  frontmatterObstacle,
  frontmatterTextOf,
  renameSkillFile,
  skillDraftOf,
  type SkillFileRename,
} from "./skillFile";
// `parseSkillFile` is deliberately NOT re-exported: `skillDraftOf` is the reading
// every surface wants, because it applies "the directory name wins over the
// frontmatter's". The raw parse, with its nullable name, is the codec's own
// business and its suite's.
