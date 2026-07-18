import { invoke } from "@tauri-apps/api/core";
import type { SkillScope } from "../domain/skills";
import { describeError, log } from "./log";

/** One stored library skill (mirrors the Rust `SkillDto`). */
export interface StoredSkill {
  scope: "global" | "workspace";
  wsId: string | null;
  name: string;
  content: string;
}

/** A workspace's staged skill views (mirrors the Rust `SkillStagingDto`).
 * Deliberately its OWN interface, not an alias of the plugin contract's
 * `SpawnSkillsInput`: the wire may one day carry host-only fields a
 * sandboxed plugin must not see, and the two shapes must be free to
 * diverge (the host narrows when it feeds hook input). */
export interface SkillsStagingViews {
  /** Claude-plugin layout (`.claude-plugin/plugin.json` + `skills/`). */
  claudePluginDir: string;
  /** OpenCode config-directory layout (`skills/` + `command/` subdirs). */
  opencodeConfigDir: string;
  /** Bare standard layout (`<skill>/SKILL.md` at the top level). */
  skillsDir: string;
}

const wire = (scope: SkillScope) =>
  scope.kind === "global"
    ? { scope: "global", wsId: null }
    : { scope: "workspace", wsId: scope.wsId };

/** Every stored skill. Degrades to an empty library if the backend errors —
 * the editor then starts blank rather than dead. */
export async function listSkills(): Promise<StoredSkill[]> {
  try {
    return await invoke<StoredSkill[]>("skills_list");
  } catch (e) {
    log.warn("web:skills", `skills_list failed; empty library: ${describeError(e)}`);
    return [];
  }
}

/** Create or overwrite one skill's SKILL.md. Throws on failure — a save the
 * user asked for must not silently vanish. */
export async function saveSkill(scope: SkillScope, name: string, content: string): Promise<void> {
  await invoke("skills_save", { ...wire(scope), name, content });
}

/** Remove one skill (its whole directory). Throws on failure. */
export async function deleteSkill(scope: SkillScope, name: string): Promise<void> {
  await invoke("skills_delete", { ...wire(scope), name });
}

/** Rename one skill by moving its directory — assets travel along. Throws
 * on failure (a name collision included). */
export async function renameSkill(scope: SkillScope, from: string, to: string): Promise<void> {
  await invoke("skills_rename", { ...wire(scope), from, to });
}

/** Rebuild and fetch a workspace's staged views; `null` = nothing to inject
 * (empty library, or staging failed — a pane spawns fine without skills).
 * `roots` (the workspace's pane spawn cwds — the Rust command's exact wire
 * key) get the codex-facing `.agents/skills` symlink armed while skills
 * exist. */
export async function stageSkills(
  wsId: string,
  roots: string[],
): Promise<SkillsStagingViews | null> {
  try {
    return await invoke<SkillsStagingViews | null>("skills_stage", { wsId, roots });
  } catch (e) {
    log.warn("web:skills", `skills_stage failed; spawning without skills: ${describeError(e)}`);
    return null;
  }
}

/** Remove KeepDeck's `.agents/skills` symlinks from the given spawn cwds
 * (a closing workspace's directories). Best-effort. */
export async function disarmSkills(roots: string[]): Promise<void> {
  if (roots.length === 0) return;
  try {
    await invoke("skills_disarm", { roots });
  } catch (e) {
    log.warn("web:skills", `skills_disarm failed: ${describeError(e)}`);
  }
}

/** Drop the derived dirs of workspaces not in `liveWsIds` (closed ones must
 * not keep dead staging around). Best-effort — a failed sweep only logs. */
export async function pruneSkills(liveWsIds: string[]): Promise<void> {
  try {
    await invoke("skills_prune", { liveWsIds });
  } catch (e) {
    log.warn("web:skills", `skills_prune failed: ${describeError(e)}`);
  }
}
