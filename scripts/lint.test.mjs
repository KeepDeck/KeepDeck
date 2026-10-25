import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * The linter, as part of the test run.
 *
 * eslint.config.js refuses casts that switch the type checker off, explicit
 * `any`, TypeScript suppression comments, and a component reaching past
 * app's hooks. The build runs it too; running
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

  it("keeps a component to app's hooks, runtime context and types", async () => {
    const eslint = new ESLint({ cwd: REPO });
    const source = [
      'import { updateSettings } from "../../app/settingsManager";',
      'import type { PluginCrash } from "../../app/pluginHealth";',
      'import { useSettings } from "../../app/useSettings";',
      'import { useReadyTasksBoard } from "../../app/tasks/useBoardState";',
      'import { useRuntimePart } from "../../app/runtimeContext";',
      "export const parts = [updateSettings, useSettings, useReadyTasksBoard, useRuntimePart];",
      "export type Crash = PluginCrash;",
      "",
    ].join("\n");
    const [view] = await eslint.lintText(source, { filePath: join(REPO, "src/components/probe/LintProbe.tsx") });
    const [test] = await eslint.lintText(source, { filePath: join(REPO, "src/components/probe/LintProbe.test.tsx") });
    expect(view.messages.map((message) => [message.line, message.ruleId])).toEqual([
      [1, "@typescript-eslint/no-restricted-imports"],
    ]);
    // A view test is the composition root of the view it renders.
    expect(test.messages).toEqual([]);
  });

  it("keeps presentation inward and gives production components IPC through ports", async () => {
    const eslint = new ESLint({ cwd: REPO });
    const [presentation] = await eslint.lintText(
      'import type { DeckStore } from "../app/deckStore";\nimport "../components/DeckStage";\nimport "../ipc/app";\nimport "../plugins/kimi/src/status";\n',
      { filePath: join(REPO, "src/presentation/lint-probe.ts") },
    );
    const [component] = await eslint.lintText(
      'import "../../ipc/app";\nimport "../../plugins/kimi/src/status";\n',
      { filePath: join(REPO, "src/components/dock/lint-probe.ts") },
    );
    const [componentTest] = await eslint.lintText(
      'import "../../ipc/app";\n',
      { filePath: join(REPO, "src/components/dock/lint-probe.test.ts") },
    );
    expect(presentation.messages.map((message) => message.ruleId)).toEqual(
      Array(4).fill("no-restricted-imports"),
    );
    expect(component.messages.map((message) => message.ruleId)).toEqual(
      Array(2).fill("no-restricted-imports"),
    );
    expect(componentTest.messages).toEqual([]);
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
    // Six seconds alone; well past two minutes on a machine running the rest
    // of the suite and other work at once. The budget is for a hung linter,
    // not a busy one.
  }, 600_000);
});
