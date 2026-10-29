import { publishingTree } from "@keepdeck/plugin-api/testing";
import { describe, expect, it } from "vitest";
import { SKILLS_PLUGIN_MANIFEST, skillsPluginDirs } from "./skillsPlugin";

describe("the skills plugin directory", () => {
  it("keeps the manifest panes have always loaded, byte for byte — no trailing newline", () => {
    // The name prefixes every skill (`keepdeck-skills:<name>`).
    expect(SKILLS_PLUGIN_MANIFEST).toBe(
      '{"name": "keepdeck-skills", "description": "Skills shared through KeepDeck", "version": "0.1.0"}',
    );
    expect(JSON.parse(SKILLS_PLUGIN_MANIFEST).name).toBe("keepdeck-skills");
  });

  it("publishes the manifest and a copy of the staged skills, whole, in the plugin's own directory", async () => {
    const writes = new Map<string, string>();
    const calls: string[] = [];
    const dirs = skillsPluginDirs({
      workspaces: { dir: async (ws) => `/pw/keepdeck.claude/${ws.id}` },
      services: {
        fsWrite: {
          writeFile: async (path, text) => void writes.set(path, text),
          copyDir: async (src, dst) => void calls.push(`copy ${src} -> ${dst}`),
          remove: async (path) => void calls.push(`remove ${path}`),
          move: async (src, dst) => void calls.push(`move ${src} -> ${dst}`),
        },
      },
    });
    const dir = await dirs.build({ id: "ws-1", instance: "i-1" }, "/kd/skills/staging/ws-1/skills");

    expect(dir).toBe("/pw/keepdeck.claude/ws-1/plugin");
    expect(writes).toEqual(new Map([[`${dir}.tmp/.claude-plugin/plugin.json`, SKILLS_PLUGIN_MANIFEST]]));
    // Every file beside each SKILL.md comes with the copy; published whole
    // over the old set, so a removed skill goes with it.
    expect(calls).toEqual([
      `remove ${dir}.tmp`,
      `copy /kd/skills/staging/ws-1/skills -> ${dir}.tmp/skills`,
      `move ${dir}.tmp -> ${dir}`,
    ]);
  });

  it("holds every file of every staged skill, and nothing a removed skill left", async () => {
    const view = "/kd/skills/staging/ws-1/skills";
    const tree = publishingTree({
      [`${view}/review/SKILL.md`]: "---\ndescription: Reviews\n---\n",
      [`${view}/review/references/design-patterns.md`]: "patterns",
      [`${view}/review/scripts/run.sh`]: "#!/bin/sh\n",
      "/pw/keepdeck.claude/ws-1/plugin/skills/gone/SKILL.md": "removed from the library",
    });
    const dirs = skillsPluginDirs({
      workspaces: { dir: async (ws) => `/pw/keepdeck.claude/${ws.id}` },
      services: { fsWrite: tree.fsWrite },
    });
    const dir = await dirs.build({ id: "ws-1", instance: "i-1" }, view);

    expect(tree.files(dir)).toEqual([
      ".claude-plugin/plugin.json",
      "skills/review/SKILL.md",
      "skills/review/references/design-patterns.md",
      "skills/review/scripts/run.sh",
    ]);
    expect(tree.read(`${dir}/skills/review/references/design-patterns.md`)).toBe("patterns");
  });
});
