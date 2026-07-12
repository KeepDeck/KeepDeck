// Contract tests for the CI/release pipeline: parse the workflow YAML and
// pin the invariants that keep the pipeline safe — what each workflow may and
// may not do — so a refactor that breaks the wiring fails here, not on main.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

function workflow(name) {
  return parse(
    readFileSync(
      fileURLToPath(new URL(`../.github/workflows/${name}`, import.meta.url)),
      "utf8",
    ),
  );
}

const SKIP_BUMP_COMMITS =
  "github.event_name != 'push' || !startsWith(github.event.head_commit.message, 'Bump version to ')";
const REF_OR_TRIGGER = "${{ inputs.ref || github.sha }}";

describe("ci workflow", () => {
  const ci = workflow("ci.yml");

  it("runs on pushes to main and is reusable with a ref", () => {
    expect(ci.on.push.branches).toEqual(["main"]);
    expect(ci.on.workflow_call.inputs.ref.type).toBe("string");
    expect(ci.on.workflow_call.inputs.ref.required).toBe(false);
  });

  it("skips version bump commits and tests the requested ref in every job", () => {
    for (const job of Object.values(ci.jobs)) {
      expect(job.if).toBe(SKIP_BUMP_COMMITS);
      expect(job.steps[0].with.ref).toBe(REF_OR_TRIGGER);
    }
  });

  it("covers the js suite, the rust workspace and workflow linting", () => {
    expect(Object.keys(ci.jobs).sort()).toEqual(["actionlint", "js", "rust"]);

    const jsRuns = ci.jobs.js.steps.map((s) => s.run).filter(Boolean);
    expect(jsRuns).toContain("pnpm test");
    expect(jsRuns).toContain("pnpm build");

    // tauri::generate_context! embeds ../dist at compile time, so the rust
    // job must build the frontend before the workspace compiles.
    const rustRuns = ci.jobs.rust.steps.map((s) => s.run).filter(Boolean);
    const frontend = rustRuns.indexOf("pnpm build");
    const tests = rustRuns.indexOf("cargo test --workspace");
    expect(frontend).toBeGreaterThanOrEqual(0);
    expect(tests).toBeGreaterThan(frontend);
  });
});
