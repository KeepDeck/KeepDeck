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

const packageManifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
);

const SKIP_BUMP_COMMITS =
  "github.event_name != 'push' || !startsWith(github.event.head_commit.message, 'Bump version to ')";
const REF_OR_TRIGGER = "${{ inputs.ref || github.sha }}";

describe("pnpm toolchain", () => {
  it("uses the packageManager pin in every dependency-installing workflow", () => {
    expect(packageManifest.packageManager).toMatch(/^pnpm@10\.\d+\.\d+$/);

    for (const name of ["ci.yml", "build-macos.yml"]) {
      const parsed = workflow(name);
      for (const [jobName, job] of Object.entries(parsed.jobs)) {
        const installsDependencies = job.steps.some((step) =>
          step.run?.includes("pnpm install --frozen-lockfile"),
        );
        if (!installsDependencies) continue;

        const setup = job.steps.find(
          (step) => step.uses === "pnpm/action-setup@v6",
        );
        expect(setup, `${name}/${jobName}`).toBeDefined();
        expect(
          setup.with?.version,
          `${name}/${jobName} must not override packageManager`,
        ).toBeUndefined();
      }
    }
  });
});

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

describe("build-macos workflow", () => {
  const build = workflow("build-macos.yml");

  it("is call-only and builds the exact requested ref", () => {
    expect(Object.keys(build.on)).toEqual(["workflow_call"]);
    expect(build.on.workflow_call.inputs.ref.required).toBe(true);
    expect(build.jobs.build.steps[0].with.ref).toBe("${{ inputs.ref }}");
  });

  it("builds both supported architectures natively", () => {
    expect(build.jobs.build.strategy["fail-fast"]).toBe(false);
    expect(build.jobs.build.strategy.matrix.include).toEqual([
      { runner: "macos-latest", arch: "arm64" },
      { runner: "macos-15-intel", arch: "x64" },
    ]);
  });

  it("signs updater payloads with the key from the caller's secrets", () => {
    expect(build.on.workflow_call.secrets.TAURI_SIGNING_PRIVATE_KEY.required).toBe(
      true,
    );
    const step = build.jobs.build.steps.find((s) =>
      s.name?.startsWith("Build and package"),
    );
    expect(step.env).toEqual({
      TAURI_SIGNING_PRIVATE_KEY: "${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}",
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD:
        "${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}",
    });
    expect(step.run).toContain("--config src-tauri/tauri.release.conf.json");
  });

  it("ships the zip, the updater payload and its signature per arch", () => {
    const upload = build.jobs.build.steps.at(-1);
    expect(upload.with.name).toBe("KeepDeck-macos-${{ matrix.arch }}");
    expect(upload.with.path.trim().split("\n")).toEqual([
      "KeepDeck-macos-${{ matrix.arch }}.zip",
      "KeepDeck-macos-${{ matrix.arch }}.app.tar.gz",
      "KeepDeck-macos-${{ matrix.arch }}.app.tar.gz.sig",
    ]);
    expect(upload.with["if-no-files-found"]).toBe("error");
  });
});

describe("release workflow", () => {
  const release = workflow("release.yml");

  it("is manually dispatchable, defaulting to a published build of main", () => {
    expect(release.on.workflow_dispatch.inputs.ref).toMatchObject({
      required: false,
      default: "main",
    });
    expect(release.on.workflow_dispatch.inputs.publish).toMatchObject({
      type: "boolean",
      required: false,
      default: true,
    });
  });

  it("pins the requested ref once and hands every job the same commit", () => {
    // Without pinning, a manual run's "main" would re-resolve per job — a
    // push landing mid-run would hand tests and builds different code.
    const PINNED = "${{ needs.pin.outputs.sha }}";
    expect(release.jobs.pin.outputs.sha).toBe("${{ steps.pin.outputs.sha }}");
    expect(release.jobs.test.needs).toBe("pin");
    expect(release.jobs.test.with.ref).toBe(PINNED);
    expect(release.jobs.build.with.ref).toBe(PINNED);
    expect(release.jobs.publish.steps[0].with.ref).toBe(PINNED);
  });

  it("gates the build on tests and the upload on the publish switch", () => {
    expect(release.jobs.test.uses).toBe("./.github/workflows/ci.yml");
    expect(release.jobs.build.needs).toEqual(["pin", "test"]);
    expect(release.jobs.build.uses).toBe("./.github/workflows/build-macos.yml");
    expect(release.jobs.publish.needs).toEqual(["pin", "build"]);
    expect(release.jobs.publish.if).toBe("inputs.publish");
  });

  it("serializes releases and never touches version accounting", () => {
    expect(release.concurrency).toEqual({ group: "release", queue: "max" });
    // The whole point of the split: releasing must never push to main.
    expect(JSON.stringify(release)).not.toContain("git push");
  });

  it("composes the changelog against the previously released version", () => {
    const checkout = release.jobs.publish.steps[0];
    expect(checkout.with["fetch-depth"]).toBe(0);
    const notes = release.jobs.publish.steps.find(
      (s) => s.name === "Compose the release notes",
    );
    expect(notes.run).toContain("releases/download/latest/latest.json");
    expect(notes.run).toContain("scripts/release-notes.mjs");
    const publish = release.jobs.publish.steps.at(-1);
    expect(publish.run).toContain("--notes-file notes.md");
    expect(publish.run).not.toContain('--notes "');
  });

  it("archives every version as its own release, badge and manifest stay rolling", () => {
    const archive = release.jobs.publish.steps.find(
      (s) => s.name === "Archive this version as its own release",
    );
    // The permanent history entry: same assets and notes...
    expect(archive.run).toContain('gh release create "v$VERSION"');
    expect(archive.run).toContain("--notes-file notes.md");
    expect(archive.run).toContain('--target "${{ needs.pin.outputs.sha }}"');
    for (const arch of ["arm64", "x64"]) {
      expect(archive.run).toContain(`assets/KeepDeck-macos-${arch}.zip`);
      expect(archive.run).toContain(`assets/KeepDeck-macos-${arch}.app.tar.gz`);
    }
    // ...but exactly one latest.json may exist (the rolling release's), and
    // the "Latest" badge stays on the rolling release too.
    expect(archive.run).not.toContain("latest.json");
    expect(archive.run).toContain("--latest=false");
    // History must never delay what installs and updates consume.
    const steps = release.jobs.publish.steps.map((s) => s.name);
    expect(steps.indexOf("Archive this version as its own release")).toBeGreaterThan(
      steps.indexOf('Publish the rolling "latest" release'),
    );
  });

  it("builds the updater manifest for both platforms", () => {
    const manifest = release.jobs.publish.steps.find(
      (s) => s.name === "Build the updater manifest",
    );
    expect(manifest.run).toContain("scripts/release-manifest.mjs");
    expect(manifest.run).toContain(
      "--payload darwin-aarch64=assets/KeepDeck-macos-arm64.app.tar.gz",
    );
    expect(manifest.run).toContain(
      "--payload darwin-x86_64=assets/KeepDeck-macos-x64.app.tar.gz",
    );
  });

  it("uploads payloads before the manifest, and the manifest last", () => {
    // By name, not position — the version archive step now follows it.
    const publish = release.jobs.publish.steps.find(
      (s) => s.name === 'Publish the rolling "latest" release',
    );
    const lines = publish.run.split("\n");
    const payloadUpload = lines.findIndex((l) =>
      l.includes("gh release upload latest \\"),
    );
    const manifestUpload = lines.findIndex((l) =>
      l.includes("gh release upload latest assets/latest.json --clobber"),
    );
    expect(payloadUpload).toBeGreaterThanOrEqual(0);
    expect(manifestUpload).toBeGreaterThan(payloadUpload);
    // Every asset the manifest points at is uploaded in the first batch.
    const batch = publish.run.slice(0, publish.run.indexOf("latest.json"));
    for (const arch of ["arm64", "x64"]) {
      expect(batch).toContain(`assets/KeepDeck-macos-${arch}.zip`);
      expect(batch).toContain(`assets/KeepDeck-macos-${arch}.app.tar.gz`);
      expect(batch).toContain(`assets/KeepDeck-macos-${arch}.app.tar.gz.sig`);
    }
  });
});

describe("version-bump workflow", () => {
  const bump = workflow("version-bump.yml");

  it("queues runs and exposes every manual bump kind", () => {
    expect(bump.concurrency).toEqual({ group: "version-bump", queue: "max" });
    expect(bump.on.workflow_dispatch.inputs.bump.options).toEqual([
      "patch",
      "minor",
      "major",
    ]);
  });

  it("only accounts for versions — no builds, no publishing", () => {
    expect(Object.keys(bump.jobs)).toEqual(["bump"]);
    expect(bump.jobs.bump["runs-on"]).toBe("ubuntu-latest");
    expect(JSON.stringify(bump)).not.toContain("macos");
  });

  it("pushes the bump immediately and chains a release for release-class bumps", () => {
    // Dispatching another workflow with GITHUB_TOKEN needs actions: write.
    expect(bump.permissions).toEqual({ contents: "write", actions: "write" });

    const push = bump.jobs.bump.steps.find(
      (s) => s.name === "Commit and push the bump",
    );
    expect(push.if).toBe("steps.bump.outputs.version != ''");
    expect(push.run).toContain("git push origin HEAD:main");

    const chain = bump.jobs.bump.steps.find(
      (s) => s.name === "Start the release for this bump",
    );
    expect(chain.if).toBe("steps.bump.outputs.release == 'true'");
    // The release must build the exact bump commit, not whatever main is by
    // the time the release run starts.
    expect(chain.run).toBe(
      "gh workflow run release.yml -f ref=${{ steps.push.outputs.sha }}",
    );
  });
});
