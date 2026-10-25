import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * The linter, as part of the test run.
 *
 * eslint.config.js refuses casts that switch the type checker off, explicit
 * `any`, and TypeScript suppression comments. The build runs it too; running
 * it here means a plain `vitest run` fails on a new one.
 */
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("the linter", () => {
  it("catches suppressed checks in resource JS and explicit any in TypeScript", async () => {
    const eslint = new ESLint({ cwd: REPO });
    const [resource] = await eslint.lintText(
      "// @ts-check\n// @ts-ignore\nconst value = 1;\n",
      { filePath: join(REPO, "plugins/opencode/resources/keepdeck-plugin/lint-probe.js") },
    );
    const [typescript] = await eslint.lintText(
      "const value: any = 1;\n// @ts-expect-error\nvalue();\n",
      { filePath: join(REPO, "src/lint-probe.ts") },
    );
    expect(resource.messages.map((message) => message.ruleId)).toEqual([
      "@typescript-eslint/ban-ts-comment",
    ]);
    expect(typescript.messages.map((message) => message.ruleId)).toEqual([
      "@typescript-eslint/no-explicit-any",
      "@typescript-eslint/ban-ts-comment",
    ]);
  });

  it("finds nothing in the source", async () => {
    const eslint = new ESLint({ cwd: REPO });
    const results = await eslint.lintFiles(["."]);
    const problems = results.flatMap((file) =>
      file.messages.map((m) => `${file.filePath.slice(REPO.length + 1)}:${m.line}: ${m.message}`),
    );
    // A run that read nothing proves nothing.
    expect(results.length).toBeGreaterThan(500);
    expect(problems).toEqual([]);
  }, 120_000);
});
