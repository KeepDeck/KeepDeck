import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW = fileURLToPath(
  new URL("../.github/workflows/version-bump.yml", import.meta.url),
);
const workflow = parse(readFileSync(WORKFLOW, "utf8"));
const { jobs } = workflow;
const RELEASE_IF =
  "needs.prepare.outputs.version != '' && needs.prepare.outputs.release == 'true'";
const PREPARE_RELEASE_IF =
  "steps.bump.outputs.version != '' && steps.bump.outputs.release == 'true'";

function stepNamed(job, name) {
  return job.steps.find((step) => step.name === name);
}

describe("version-bump workflow", () => {
  it("queues runs and exposes every manual bump kind", () => {
    expect(workflow.concurrency).toEqual({ group: "version-bump", queue: "max" });
    expect(workflow.on.workflow_dispatch.inputs.bump.options).toEqual([
      "patch",
      "minor",
      "major",
    ]);
  });

  it("commits automatic patches without entering the release build", () => {
    expect(jobs.prepare.outputs).toMatchObject({
      base_sha: "${{ steps.base.outputs.sha }}",
      version: "${{ steps.bump.outputs.version }}",
      release: "${{ steps.bump.outputs.release }}",
    });

    const compute = stepNamed(jobs.prepare, "Compute and apply the bump");
    expect(compute.run).toContain("github.event_name == 'workflow_dispatch'");
    expect(compute.run).toContain("format('--bump {0}', inputs.bump)");

    const patchCommit = stepNamed(jobs.prepare, "Commit and push patch bump");
    expect(patchCommit.if).toBe(
      "steps.bump.outputs.version != '' && steps.bump.outputs.release != 'true'",
    );
    expect(patchCommit.run).toContain("git push origin HEAD:main");

    expect(jobs.build.needs).toBe("prepare");
    expect(jobs.build.if).toBe(RELEASE_IF);
  });

  it("builds both supported architectures from the prepared source", () => {
    expect(jobs.build.strategy["fail-fast"]).toBe(false);
    expect(jobs.build.strategy.matrix.include).toEqual([
      { runner: "macos-latest", asset: "KeepDeck-macos-arm64.zip" },
      { runner: "macos-15-intel", asset: "KeepDeck-macos-x64.zip" },
    ]);

    const preserve = stepNamed(jobs.prepare, "Preserve the prepared release version");
    expect(preserve.if).toBe(PREPARE_RELEASE_IF);
    expect(preserve.with.name).toBe("version-files");
    expect(preserve.with.path.trim().split("\n")).toEqual([
      "Cargo.lock",
      "package.json",
      "src-tauri/Cargo.toml",
    ]);

    const checkout = jobs.build.steps[0];
    expect(checkout.with.ref).toBe("${{ needs.prepare.outputs.base_sha }}");
    expect(stepNamed(jobs.build, "Restore the prepared release version").with).toEqual({
      name: "version-files",
      path: ".",
    });

    const upload = jobs.build.steps.at(-1);
    expect(upload.with).toMatchObject({
      name: "${{ matrix.asset }}",
      path: "${{ matrix.asset }}",
      "if-no-files-found": "error",
    });
  });

  it("pushes and publishes a release only after the complete build matrix", () => {
    expect(jobs.bump_release.needs).toEqual(["prepare", "build"]);
    expect(jobs.bump_release.if).toBe(RELEASE_IF);

    expect(jobs.bump_release.steps[0].with.ref).toBe(
      "${{ needs.prepare.outputs.base_sha }}",
    );
    expect(
      stepNamed(jobs.bump_release, "Restore the prepared release version").with,
    ).toEqual({ name: "version-files", path: "." });

    const releaseCommit = stepNamed(jobs.bump_release, "Commit and push release bump");
    expect(releaseCommit.run).toContain("git push origin HEAD:main");

    expect(jobs.publish.needs).toEqual(["prepare", "build", "bump_release"]);
    expect(jobs.publish.if).toBe(RELEASE_IF);
    expect(jobs.publish.steps[0].with.pattern).toBe("KeepDeck-macos-*");
  });
});
