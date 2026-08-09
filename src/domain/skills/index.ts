/**
 * Shared agent skills — the SKILL.md library authored inside KeepDeck and
 * distributed to every CLI at spawn time (storage and staging live behind
 * `src/ipc/skills.ts`).
 *
 * `skills.ts` holds the rules — scope, draft, naming and description verdicts.
 * `skillFile.ts` holds the codec that reads and writes the file.
 */
export * from "./skills";
export * from "./skillFile";
