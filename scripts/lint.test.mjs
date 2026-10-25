import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * The linter, as part of the test run.
 *
 * eslint.config.js refuses the casts that switch the type checker off
 * (`as never`, `as unknown as`). The build runs it too; running it here as
 * well means a plain `vitest run` fails on a new one, with no separate step
 * anybody has to remember.
 */
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("the linter", () => {
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
