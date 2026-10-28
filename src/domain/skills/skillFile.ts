/**
 * The SKILL.md codec, as the library reads it. The codec itself lives in the
 * plugin contract (`@keepdeck/plugin-api`, `context/skill.ts`) — the host and
 * every plugin read a skill by the same rules — and this module adds the one
 * rule that is the library's own: the DIRECTORY name wins over the file's.
 */
import { parseSkillFile, type SkillDraft } from "@keepdeck/plugin-api";

/** A stored skill as the editable draft. The DIRECTORY name wins over the
 * frontmatter's — the directory is what every CLI keys on, and a hand-edited
 * file can disagree. Takes the stored row structurally, like [`skillScopeOf`],
 * so the domain does not reach for the IPC type mirroring it.
 *
 * Here rather than at a call site because four surfaces need it — the library's
 * `read`, the editor when a skill is opened, the nav's description column, and
 * the `skills.list` command — and a change like "fall back to the first body
 * line when the frontmatter has no description" must reach all four. */
export function skillDraftOf(stored: { name: string; content: string }): SkillDraft {
  return { ...parseSkillFile(stored.content), name: stored.name };
}
