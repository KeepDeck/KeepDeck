import { invoke } from "@tauri-apps/api/core";
import type { SpawnSkillsInput } from "@keepdeck/plugin-api";
import type { SkillScope } from "../domain/skills";
import { describeError, log } from "./log";

/** One stored library skill (mirrors the Rust `SkillDto`). */
export interface StoredSkill {
  scope: "global" | "workspace";
  wsId: string | null;
  name: string;
  content: string;
}

/** A workspace's staged skill views (mirrors the Rust `SkillStagingDto`) —
 * exactly the shape hooks receive, so the wire and the plugin contract
 * cannot drift apart. */
export type SkillsStagingViews = SpawnSkillsInput;

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

/** Rebuild and fetch a workspace's staged views; `null` = nothing to inject
 * (empty library, or staging failed — a pane spawns fine without skills). */
export async function stageSkills(wsId: string): Promise<SkillsStagingViews | null> {
  try {
    return await invoke<SkillsStagingViews | null>("skills_stage", { wsId });
  } catch (e) {
    log.warn("web:skills", `skills_stage failed; spawning without skills: ${describeError(e)}`);
    return null;
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
