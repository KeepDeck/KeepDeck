/**
 * The skills shipped inside the app (`src-tauri/src/skills/bundled/`) are
 * fit to hand an agent by the same judgement every library skill is held to.
 * Staging skips a skill the host judges unfit — for a bundled one that would
 * mean the binary shipped a skill no agent ever receives, so it fails here,
 * at test time, instead.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { skillsUnfitForAgents } from "./skills";

const BUNDLED = resolve(dirname(fileURLToPath(import.meta.url)), "../../../src-tauri/src/skills/bundled");

describe("the bundled skills tier", () => {
  it("ships only skills fit for agents", () => {
    const rows = readdirSync(BUNDLED).map((name) => ({
      name,
      content: readFileSync(join(BUNDLED, name, "SKILL.md"), "utf8"),
    }));
    expect(rows.length).toBeGreaterThan(0);
    expect(skillsUnfitForAgents(rows).map((row) => row.name)).toEqual([]);
  });
});
