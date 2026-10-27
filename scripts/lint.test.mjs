import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * The linter, as part of the test run.
 *
 * eslint.config.js refuses casts that switch the type checker off, explicit
 * `any`, TypeScript suppression comments, a component reaching past
 * app's hooks, and a CLI named in the core. The build runs it too; running
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
  }, 60_000);

  it("catches an unchecked assertion in src and in a plugin", async () => {
    const eslint = new ESLint({ cwd: REPO });
    const source = 'const raw: unknown = "x";\nexport const text = raw as string;\n';
    const [src] = await eslint.lintText(source, {
      filePath: join(REPO, "src/lint-probe.ts"),
    });
    const [plugin] = await eslint.lintText(source, {
      filePath: join(REPO, "plugins/opencode/src/lint-probe.ts"),
    });
    expect(src.messages.map((message) => message.ruleId)).toEqual([
      "@typescript-eslint/no-unsafe-type-assertion",
    ]);
    expect(plugin.messages.map((message) => message.ruleId)).toEqual([
      "@typescript-eslint/no-unsafe-type-assertion",
    ]);
  });

  it("keeps a component to app's hooks, runtime context and types, and its test to app/testing besides", async () => {
    const eslint = new ESLint({ cwd: REPO });
    const source = [
      'import { updateSettings } from "../../app/settingsManager";',
      'import type { PluginCrash } from "../../app/pluginHealth";',
      'import { useSettings } from "../../app/useSettings";',
      'import { useReadyTasksBoard } from "../../app/tasks/useBoardState";',
      'import { useRuntimePart } from "../../app/runtimeContext";',
      'import { createUsageManager } from "../../app/testing";',
      "export const parts = [updateSettings, useSettings, useReadyTasksBoard, useRuntimePart, createUsageManager];",
      "export type Crash = PluginCrash;",
      "",
    ].join("\n");
    const [view] = await eslint.lintText(source, { filePath: join(REPO, "src/components/probe/LintProbe.tsx") });
    const [test] = await eslint.lintText(source, { filePath: join(REPO, "src/components/probe/LintProbe.test.tsx") });
    expect(view.messages.map((message) => [message.line, message.ruleId])).toEqual([
      [1, "@typescript-eslint/no-restricted-imports"],
      [6, "@typescript-eslint/no-restricted-imports"],
    ]);
    // A view test has one door more — app/testing — and no other.
    expect(test.messages.map((message) => [message.line, message.ruleId])).toEqual([
      [1, "@typescript-eslint/no-restricted-imports"],
    ]);
  });

  it("keeps presentation inward and gives production components IPC through ports", async () => {
    const eslint = new ESLint({ cwd: REPO });
    const [presentation] = await eslint.lintText(
      'import type { DeckStore } from "../app/deckStore";\nimport "../components/DeckStage";\nimport "../ipc/app";\nimport "../plugins/git/src/status";\n',
      { filePath: join(REPO, "src/presentation/lint-probe.ts") },
    );
    const [component] = await eslint.lintText(
      'import "../../ipc/app";\nimport "../../plugins/git/src/status";\n',
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

  it("checks every plugin resource JS with @ts-check", () => {
    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        const relative = path.slice(REPO.length + 1);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".js") && /^plugins\/[^/]+\/resources\//.test(relative)) {
          files.push(path);
        }
      }
    };
    walk(join(REPO, "plugins"));
    // A run that read nothing proves nothing.
    expect(files.length).toBeGreaterThan(20);
    const missing = files
      .filter((file) => !readFileSync(file, "utf8").split("\n").slice(0, 6).some((line) => line.trim() === "// @ts-check"))
      .map((file) => file.slice(REPO.length + 1));
    expect(missing).toEqual([]);
  });

  it("holds a component test's run-time loads to its surface too", async () => {
    const eslint = new ESLint({ cwd: REPO });
    const source = [
      'import { vi } from "vitest";',
      'vi.mock("../../app/settingsManager", () => ({}));',
      'vi.mock("../../app/useSettings", () => ({}));',
      'export const load = async () => [await import("../../app/settingsManager"), await import("../../app/testing")];',
      "",
    ].join("\n");
    const [test] = await eslint.lintText(source, { filePath: join(REPO, "src/components/probe/LintProbe.test.tsx") });
    expect(test.messages.map((message) => [message.line, message.ruleId])).toEqual([
      [2, "no-restricted-syntax"],
      [4, "no-restricted-syntax"],
    ]);
    // A production component has no app/testing door, at run time either.
    const [view] = await eslint.lintText(
      'export const load = async () => [await import("../../app/settingsManager"), await import("../../app/testing"), await import("../../app/useSettings")];\n',
      { filePath: join(REPO, "src/components/probe/LintProbe.tsx") },
    );
    expect(view.messages.filter((message) => message.ruleId === "no-restricted-syntax").length).toBe(2);
  });

  it("refuses a CLI named in the core, not in a plugin, a test or a comment", async () => {
    const eslint = new ESLint({ cwd: REPO });
    const leak = [
      "// codex in a comment decides nothing",
      'export const home = "CODEX_HOME";',
      "export const kimiDir = `${home}/.kimi-code`;",
      'export const encode = (codec: string) => "open code " + codec;',
      "",
    ].join("\n");
    const rule = (result) => result.messages.filter((message) => message.ruleId === "keepdeck/no-cli-names");
    const [src] = await eslint.lintText(leak, { filePath: join(REPO, "src/lint-probe.ts") });
    expect(rule(src).map((message) => message.line)).toEqual([2, 3, 3]);
    // A block that redefines no-restricted-syntax does not drop it.
    const [component] = await eslint.lintText(leak, { filePath: join(REPO, "src/components/dock/lint-probe.ts") });
    expect(rule(component)).toHaveLength(3);
    const [plugin] = await eslint.lintText(leak, { filePath: join(REPO, "plugins/opencode/src/lint-probe.ts") });
    const [test] = await eslint.lintText(leak, { filePath: join(REPO, "src/components/dock/lint-probe.test.ts") });
    expect([rule(plugin), rule(test)]).toEqual([[], []]);
  });

  it("holds an exempt file to its listed count and drops a stale exemption", async () => {
    const eslint = new ESLint({ cwd: REPO });
    // src/app/mcp/injection.ts is exempt for one "kimi".
    const filePath = join(REPO, "src/app/mcp/injection.ts");
    const source = readFileSync(filePath, "utf8");
    const messages = async (text) =>
      (await eslint.lintText(text, { filePath }))[0].messages
        .filter((message) => message.ruleId === "keepdeck/no-cli-names")
        .map((message) => message.message);
    expect(await messages(source)).toEqual([]);
    expect(await messages(`${source}\nexport const more = "kimi";\n`)).toEqual([
      expect.stringContaining("the new one belongs in the CLI's plugin"),
    ]);
    expect(await messages(`${source}\nexport const other = "codex";\n`)).toEqual([
      expect.stringContaining("not codex"),
      expect.stringContaining("the new one belongs in the CLI's plugin"),
    ]);
    expect(await messages("export const nothing = 1;\n")).toEqual([expect.stringContaining("delete its exemption")]);
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
