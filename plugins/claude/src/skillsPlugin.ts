/**
 * The shared skills as a LOCAL claude plugin, built by this plugin in its own
 * workspace directory (`ctx.workspaces`) — `<dir>/plugin/`, which a pane gets
 * as `--plugin-dir`: additive next to the user's installed plugins, nothing
 * written into `~/.claude` (probe-verified on 2.1.214: the skills load with
 * no consent prompt, named `keepdeck-skills:<name>`).
 *
 * Its `skills/` is a copy of the staged view, so every file beside each
 * SKILL.md comes along — the references and scripts a skill points its agent
 * at, binary or not. A symlink to the view would not do: claude's own check
 * of a plugin folder does not count a skill reached through one (read in the
 * 2.1.312 binary).
 *
 * The directory is published whole ([`publishFiles`]), one build at a time
 * per workspace, so a pane starting mid-rebuild loads the old set or the new
 * one, and a skill removed from the library is gone with the old set.
 */
import {
  oneAtATime,
  publishFiles,
  type PluginWorkspaces,
  type PublishingFsWrite,
  type WorkspaceRef,
} from "@keepdeck/plugin-api";

/** The plugin's manifest, byte for byte as panes have always loaded it. Its
 * `name` prefixes every skill (`keepdeck-skills:<name>`), so renaming it would
 * rename every skill a user has learned to call. */
export const SKILLS_PLUGIN_MANIFEST =
  '{"name": "keepdeck-skills", "description": "Skills shared through KeepDeck", "version": "0.1.0"}';

/** What building the directory needs from the host. */
export interface SkillsPluginPorts {
  workspaces: PluginWorkspaces;
  services: { fsWrite: PublishingFsWrite };
}

export interface SkillsPluginDirs {
  /** The workspace's skills plugin directory, holding exactly the skills
   * staged in `skillsDir` (`SpawnSkillsInput.dir`). */
  build(workspace: WorkspaceRef, skillsDir: string): Promise<string>;
}

export function skillsPluginDirs(ctx: SkillsPluginPorts): SkillsPluginDirs {
  const serial = oneAtATime();

  async function build(workspace: WorkspaceRef, skillsDir: string): Promise<string> {
    const dir = `${await ctx.workspaces.dir(workspace)}/plugin`;
    await publishFiles(ctx.services.fsWrite, dir, [
      { path: ".claude-plugin/plugin.json", text: SKILLS_PLUGIN_MANIFEST },
      { path: "skills", from: skillsDir },
    ]);
    return dir;
  }

  return { build: (workspace, skillsDir) => serial(workspace.id, () => build(workspace, skillsDir)) };
}
