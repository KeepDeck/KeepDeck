/**
 * opencode 1.x's skills config directory, built by this plugin in its own
 * workspace directory (`ctx.workspaces`) — `<dir>/config/`, the directory a
 * 1.x pane gets as `OPENCODE_CONFIG_DIR`.
 *
 * Each skill is carried twice: `skills/<name>/SKILL.md` for the model's own
 * `skill` tool, and `command/<name>.md`, a palette command, because opencode
 * lists no skills and has no slash form of its own — a loaded skill would be
 * invisible in its UI. The command's description is the skill's own and its
 * body POINTS AT the staged SKILL.md rather than inlining it, so it cannot go
 * stale when the skill is edited.
 *
 * Only those two subtrees are ours. opencode treats the directory as a
 * writable home — it installs its plugin `node_modules` and drops account
 * and state files there (field-verified on 1.18.3) — so everything else in it
 * survives every rebuild. Each subtree is built aside and published whole
 * (`fsWrite.move`): a pane starting mid-rebuild reads the old set or the new
 * one, never half of each.
 */
import {
  frontmatterLine,
  oneAtATime,
  publishFiles,
  type PluginFsWrite,
  type PluginWorkspaces,
  type SpawnSkill,
  type WorkspaceRef,
} from "@keepdeck/plugin-api";

/** What building the directory needs from the host. */
export interface LayoutPorts {
  workspaces: PluginWorkspaces;
  services: { fsWrite: Pick<PluginFsWrite, "writeFile" | "remove" | "move"> };
}

/** The palette command generated for one skill. Its description is the
 * skill's, lifted byte for byte ([`frontmatterLine`]) — a block scalar comes
 * back folded and quoted, so this frontmatter still parses. */
export function paletteCommand(name: string, content: string, stagedSkill: string): string {
  const description = frontmatterLine(content, "description") ?? "";
  return (
    `---\ndescription: ${description}\n---\n` +
    `Use the "${name}" skill: read ${stagedSkill} and follow its instructions for this request: $ARGUMENTS\n`
  );
}

export interface SkillsConfigDirs {
  /** The workspace's config directory, holding exactly `skills` — rebuilt,
   * one build at a time per workspace. */
  build(workspace: WorkspaceRef, skills: readonly SpawnSkill[]): Promise<string>;
}

export function skillsConfigDirs(ctx: LayoutPorts): SkillsConfigDirs {
  /** One build at a time per workspace: two panes starting together share
   * the build-aside directories. */
  const serial = oneAtATime();

  async function build(workspace: WorkspaceRef, skills: readonly SpawnSkill[]): Promise<string> {
    const { fsWrite } = ctx.services;
    const config = `${await ctx.workspaces.dir(workspace)}/config`;
    await publishFiles(
      fsWrite,
      `${config}/skills`,
      skills.map(({ name, content }) => ({ path: `${name}/SKILL.md`, text: content })),
    );
    await publishFiles(
      fsWrite,
      `${config}/command`,
      skills.map(({ name, content }) => ({
        path: `${name}.md`,
        text: paletteCommand(name, content, `${config}/skills/${name}/SKILL.md`),
      })),
    );
    return config;
  }

  return { build: (workspace, skills) => serial(workspace.id, () => build(workspace, skills)) };
}
