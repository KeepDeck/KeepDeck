/** The infrastructure manager must not construct capability features. */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WORKTREES_DIR = fileURLToPath(new URL("./", import.meta.url));

describe("worktrees stays on infrastructure ports", () => {
  it("has no production import of skills or MCP feature modules", () => {
    const production = readdirSync(WORKTREES_DIR)
      .filter((name) => name.endsWith(".ts"))
      .filter((name) => !name.endsWith(".test.ts") && name !== "testSupport.ts");
    expect(production.length).toBeGreaterThan(0);
    for (const name of production) {
      const source = readFileSync(`${WORKTREES_DIR}/${name}`, "utf8");
      expect(
        source,
        `${name} must not construct a feature through a direct IPC import`,
      ).not.toMatch(/from\s+["'](?:\.\.\/)+ipc\/(?:skills|mcpArming)["']/);
    }
  });
});
