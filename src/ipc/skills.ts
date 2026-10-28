import { invoke } from "@tauri-apps/api/core";
import type { SkillScope } from "../domain/skills";
import { log } from "./log";
import { errorMessage } from "@keepdeck/plugin-api";

/** One stored library skill (mirrors the Rust `SkillDto`). A `bundled`
 * row is READ-ONLY: the tier ships with the app; mutations refuse
 * Rust-side and this module's own mutation mapper throws on the scope
 * (the programming-error backstop — the TS door never issues one). */
export interface StoredSkill {
  scope: "global" | "workspace" | "bundled";
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
  /** The bare standard layout (`<skill>/SKILL.md` at the top level), and
   * each staged skill as text. */
  dir: string;
  skills: { name: string; content: string }[];
}

/** A stored row the host judged unfit to hand any agent, in the wire's own
 * terms — the scope and workspace of a `StoredSkill`, and its name. */
export type ExcludedSkill = Pick<StoredSkill, "scope" | "wsId" | "name">;

/** A scope in the shape the wire carries. Typed as the stored row's own two
 * fields, not an inferred literal, so this and the domain's `skillScopeOf` —
 * which is exactly its inverse — cannot drift apart silently; the round trip is
 * pinned in this module's suite. The MAPPING direction only: bundled rows
 * arrive on reads and never leave — a bundled scope here is a programming
 * error, thrown loudly (the Rust side owns the real refusal). */
const wire = (scope: SkillScope): Pick<StoredSkill, "scope" | "wsId"> => {
  if (scope.kind === "bundled") {
    throw new Error(
      "bundled skills ship with KeepDeck — mutations address your own library",
    );
  }
  return scope.kind === "global"
    ? { scope: "global", wsId: null }
    : { scope: "workspace", wsId: scope.wsId };
};

/** The raw library read — THROWS on a backend error, for callers that must
 * tell "empty" from "unreachable" (a failed-save reload keeps its stale
 * list rather than showing an empty lie). */
export async function fetchSkills(): Promise<StoredSkill[]> {
  return await invoke<StoredSkill[]>("skills_list");
}

/**
 * Write one skill's SKILL.md. Throws on failure — a save the user asked for
 * must not silently vanish.
 *
 * `expectNew` says this is a CREATE, and the backend then refuses a name that
 * is already taken. The dialog checks the name too, but only against the
 * library it managed to list; this is the check that cannot be skipped by a
 * read that failed.
 */
export async function saveSkill(
  scope: SkillScope,
  name: string,
  content: string,
  expectNew: boolean,
): Promise<void> {
  await invoke("skills_save", { ...wire(scope), name, content, expectNew });
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
 * `excluded` rows stage nowhere. */
export async function stageSkills(
  wsId: string,
  excluded: readonly ExcludedSkill[],
): Promise<SkillsStagingViews | null> {
  try {
    return await invoke<SkillsStagingViews | null>("skills_stage", { wsId, excluded });
  } catch (e) {
    log.warn("web:skills", `skills_stage failed; spawning without skills: ${errorMessage(e)}`);
    return null;
  }
}

/** Drop the derived dirs of workspaces not in `liveWsIds` (closed ones must
 * not keep dead staging around). Best-effort — a failed sweep only logs — and
 * reports whether it got through, so the sweep that records "this state is
 * cleaned up" can decline to record a failure. */
export async function pruneSkills(liveWsIds: string[]): Promise<boolean> {
  try {
    await invoke("skills_prune", { liveWsIds });
    return true;
  } catch (e) {
    log.warn("web:skills", `skills_prune failed: ${errorMessage(e)}`);
    return false;
  }
}
