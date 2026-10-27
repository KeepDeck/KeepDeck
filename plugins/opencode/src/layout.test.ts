import { describe, expect, it } from "vitest";
import { paletteCommand, skillsConfigDirs } from "./layout";

const workspace = { id: "ws-1", instance: "i-1" };
const STAGED = "/pw/keepdeck.opencode/ws-1/config/skills/review/SKILL.md";

describe("paletteCommand — the bytes opencode reads", () => {
  // Pinned to what the host's own renderer (skills/opencode.rs) wrote before
  // the layout moved here: a pane must see the same commands after the move.
  it("carries a one-line description verbatim and points at the staged skill", () => {
    expect(paletteCommand("review", "---\nname: review\ndescription: Reviews a diff\n---\nB\n", STAGED)).toBe(
      "---\ndescription: Reviews a diff\n---\n" +
        `Use the "review" skill: read ${STAGED} and follow its instructions for this request: $ARGUMENTS\n`,
    );
  });

  it("keeps the author's quoting, so a colon stays inside the value", () => {
    const content = "---\nname: x\ndescription: \"Use when: it's risky\"\n---\nB\n";
    expect(paletteCommand("x", content, "/s/SKILL.md").startsWith('---\ndescription: "Use when: it\'s risky"\n---\n')).toBe(
      true,
    );
  });

  it("folds a block scalar into a quoted line its own frontmatter still parses", () => {
    for (const content of [
      "---\ndescription: |\n  Use when: risky\n---\nB\n",
      "---\ndescription: >\n  Use #1 tool\n---\nB\n",
    ]) {
      const line = paletteCommand("x", content, "/s/SKILL.md").split("\n")[1];
      expect(line).toMatch(/^description: ".*"$/);
    }
  });

  it("reads a CRLF file as the YAML reading does", () => {
    expect(paletteCommand("x", "---\r\nname: x\r\ndescription: Ships it\r\n---\r\nB\r\n", "/s").split("\n")[1]).toBe(
      "description: Ships it",
    );
  });
});

/** A recording fsWrite: the calls in order, and what each write wrote. */
function recordingWrites() {
  const calls: string[] = [];
  const files = new Map<string, string>();
  return {
    calls,
    files,
    fsWrite: {
      writeFile: async (path: string, text: string) => {
        calls.push(`write ${path}`);
        files.set(path, text);
      },
      remove: async (path: string) => {
        calls.push(`remove ${path}`);
      },
      move: async (src: string, dst: string) => {
        calls.push(`move ${src} -> ${dst}`);
      },
    },
  };
}

describe("skillsConfigDirs — the 1.x config directory", () => {
  const ports = (fsWrite: ReturnType<typeof recordingWrites>["fsWrite"]) => ({
    workspaces: { dir: async (ws: { id: string }) => `/pw/keepdeck.opencode/${ws.id}` },
    services: { fsWrite },
  });
  const skills = [
    { name: "alpha", content: "---\ndescription: First\n---\nA\n" },
    { name: "review", content: "---\ndescription: Reviews\n---\nR\n" },
  ];

  it("builds both subtrees aside in the plugin's own directory and publishes each whole", async () => {
    const w = recordingWrites();
    const dir = await skillsConfigDirs(ports(w.fsWrite)).build(workspace, skills);
    const config = "/pw/keepdeck.opencode/ws-1/config";
    expect(dir).toBe(config);
    expect(w.calls).toEqual([
      `remove ${config}/.skills-tmp`,
      `remove ${config}/.command-tmp`,
      `write ${config}/.skills-tmp/alpha/SKILL.md`,
      `write ${config}/.command-tmp/alpha.md`,
      `write ${config}/.skills-tmp/review/SKILL.md`,
      `write ${config}/.command-tmp/review.md`,
      `move ${config}/.skills-tmp -> ${config}/skills`,
      `move ${config}/.command-tmp -> ${config}/command`,
    ]);
    // The skill byte for byte; its command points at where the skill LANDS.
    expect(w.files.get(`${config}/.skills-tmp/review/SKILL.md`)).toBe(skills[1].content);
    expect(w.files.get(`${config}/.command-tmp/review.md`)).toContain(`read ${config}/skills/review/SKILL.md and`);
  });

  it("builds one workspace's directory at a time — two launches never share a half-built set", async () => {
    const w = recordingWrites();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const slowMove = w.fsWrite.move;
    let first = true;
    w.fsWrite.move = async (src, dst) => {
      if (first) {
        first = false;
        await held;
      }
      return slowMove(src, dst);
    };
    const dirs = skillsConfigDirs(ports(w.fsWrite));
    const a = dirs.build(workspace, skills.slice(0, 1));
    const b = dirs.build(workspace, skills.slice(1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    // The second build has not started: its cleanup would have run by now.
    expect(w.calls.filter((call) => call.startsWith("remove"))).toHaveLength(2);
    release();
    await Promise.all([a, b]);
    expect(w.calls.filter((call) => call.startsWith("remove"))).toHaveLength(4);
  });

  it("a failed build does not stall the next one", async () => {
    const w = recordingWrites();
    const failing = { ...w.fsWrite, move: async () => Promise.reject(new Error("disk full")) };
    const dirs = skillsConfigDirs({ ...ports(w.fsWrite), services: { fsWrite: failing } });
    await expect(dirs.build(workspace, skills)).rejects.toThrow("disk full");
    await expect(dirs.build(workspace, skills)).rejects.toThrow("disk full");
  });
});
