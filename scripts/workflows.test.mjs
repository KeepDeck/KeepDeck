// Contract tests for the CI/release pipeline: parse the workflow YAML and
// pin the invariants that keep the pipeline safe — what each workflow may and
// may not do — so a refactor that breaks the wiring fails here, not on main.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { isRecord } from "./lib/guards.mjs";

/** @typedef {{ name?: string, uses?: string, run?: string, if?: string, env?: unknown, with?: Record<string, unknown> }} Step */
/** @typedef {{ if?: string, uses?: string, needs?: unknown, with?: Record<string, unknown>, outputs?: unknown, strategy?: unknown, "runs-on"?: unknown, "timeout-minutes"?: unknown, steps?: Step[] }} Job */
/** @typedef {{ on: Record<string, unknown>, jobs: Record<string, Job>, concurrency?: unknown, permissions?: unknown }} Workflow */


/**
 * @param {Record<string, unknown>} record
 * @param {string[]} keys
 */
function stringsOrAbsent(record, keys) {
  return keys.every((key) => record[key] === undefined || typeof record[key] === "string");
}

/**
 * @param {unknown} value
 * @returns {value is Step}
 */
function isStep(value) {
  return (
    isRecord(value) &&
    stringsOrAbsent(value, ["name", "uses", "run", "if"]) &&
    (value.with === undefined || isRecord(value.with))
  );
}

/**
 * @param {unknown} value
 * @returns {value is Job}
 */
function isJob(value) {
  return (
    isRecord(value) &&
    stringsOrAbsent(value, ["if", "uses"]) &&
    (value.with === undefined || isRecord(value.with)) &&
    (value.steps === undefined || (Array.isArray(value.steps) && value.steps.every(isStep)))
  );
}

/**
 * @param {unknown} value
 * @returns {value is Workflow}
 */
function isWorkflow(value) {
  return isRecord(value) && isRecord(value.on) && isRecord(value.jobs) && Object.values(value.jobs).every(isJob);
}

/**
 * @param {string} name
 * @returns {Workflow}
 */
function workflow(name) {
  const parsed = parse(
    readFileSync(
      fileURLToPath(new URL(`../.github/workflows/${name}`, import.meta.url)),
      "utf8",
    ),
  );
  if (!isWorkflow(parsed)) throw new Error(`${name} is not a workflow of jobs and steps`);
  return parsed;
}

/**
 * @template T
 * @param {T | undefined} value
 * @param {string} what
 * @returns {T}
 */
function required(value, what) {
  if (value === undefined) throw new Error(`no ${what}`);
  return value;
}

/**
 * What a nested YAML mapping holds at `path`; absent is a failure by name.
 * @param {unknown} root
 * @param {...string} path
 * @returns {unknown}
 */
function at(root, ...path) {
  let current = root;
  for (const key of path) {
    if (!isRecord(current) || !(key in current)) throw new Error(`no ${path.join(".")}`);
    current = current[key];
  }
  return current;
}

/**
 * @param {unknown} value
 * @param {string} what
 * @returns {string}
 */
function text(value, what) {
  if (typeof value !== "string") throw new Error(`${what}: expected text`);
  return value;
}

/**
 * @param {Job} job
 * @returns {Step[]}
 */
function stepsOf(job) {
  return required(job.steps, "steps in the job");
}

/**
 * @param {Job} job
 * @param {string} name
 * @returns {Step}
 */
function stepNamed(job, name) {
  return required(stepsOf(job).find((step) => step.name === name), `step "${name}"`);
}

/**
 * @param {Step} step
 * @returns {string}
 */
function runOf(step) {
  return required(step.run, `run script in step "${step.name}"`);
}

const packageManifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
);

const SKIP_BUMP_COMMITS =
  "github.event_name != 'push' || !startsWith(github.event.head_commit.message, 'Bump version to ')";
const REF_OR_TRIGGER = "${{ inputs.ref || github.sha }}";

describe("every workflow", () => {
  it("bounds each job that runs steps, so a hang fails instead of running for six hours", () => {
    // Without timeout-minutes GitHub lets a job run for 360 minutes. The
    // bound belongs to the job, not to a test inside it: a step that hangs —
    // the bundle check's render waiting on a timer that never ends — is
    // turned into a failure. Each job's is about three times its slowest
    // green run — room for a cold cache, nowhere near six hours — or, where
    // none has been measured yet, a generous bound for its work; the comment
    // beside it says which. A job that only calls a reusable workflow takes
    // no bound of its own (GitHub refuses one there); the jobs it calls carry
    // theirs, and they are checked here as well.
    const names = readdirSync(fileURLToPath(new URL("../.github/workflows", import.meta.url)))
      .filter((name) => name.endsWith(".yml"));
    expect(names.length).toBeGreaterThan(0);
    const unbounded = names.flatMap((name) =>
      Object.entries(workflow(name).jobs)
        .filter(([, job]) => job.steps !== undefined)
        .filter(([, job]) => {
          const minutes = job["timeout-minutes"];
          return !(typeof minutes === "number" && Number.isInteger(minutes) && minutes > 0 && minutes < 360);
        })
        .map(([id]) => `${name}/${id}`),
    );
    expect(unbounded).toEqual([]);
  });
});

describe("pnpm toolchain", () => {
  it("uses the packageManager pin in every dependency-installing workflow", () => {
    expect(packageManifest.packageManager).toMatch(/^pnpm@10\.\d+\.\d+$/);

    for (const name of ["ci.yml", "build-macos.yml"]) {
      const parsed = workflow(name);
      for (const [jobName, job] of Object.entries(parsed.jobs)) {
        const installsDependencies = stepsOf(job).some((step) =>
          step.run?.includes("pnpm install --frozen-lockfile"),
        );
        if (!installsDependencies) continue;

        const setup = stepsOf(job).find(
          (step) => step.uses === "pnpm/action-setup@v6",
        );
        expect(setup, `${name}/${jobName}`).toBeDefined();
        expect(
          setup?.with?.version,
          `${name}/${jobName} must not override packageManager`,
        ).toBeUndefined();
      }
    }
  });
});

describe("ci workflow", () => {
  const ci = workflow("ci.yml");

  it("runs on pushes to main and is reusable with a ref", () => {
    expect(at(ci.on, "push", "branches")).toEqual(["main"]);
    expect(at(ci.on, "workflow_call", "inputs", "ref", "type")).toBe("string");
    expect(at(ci.on, "workflow_call", "inputs", "ref", "required")).toBe(false);
  });

  it("skips version bump commits and tests the requested ref in every job", () => {
    for (const job of Object.values(ci.jobs)) {
      expect(job.if).toBe(SKIP_BUMP_COMMITS);
      expect(stepsOf(job)[0].with?.ref).toBe(REF_OR_TRIGGER);
    }
  });

  it("covers the js suite, the shell scripts, the rust workspace and workflow linting", () => {
    expect(Object.keys(ci.jobs).sort()).toEqual(["actionlint", "js", "rust"]);

    const jsRuns = stepsOf(ci.jobs.js).map((s) => s.run).filter(Boolean);
    expect(jsRuns).toContain("pnpm test");
    expect(jsRuns).toContain("pnpm lint:shell");
    expect(jsRuns).toContain("pnpm build");

    // tauri::generate_context! embeds ../dist at compile time, so the rust
    // job must build the frontend before the workspace compiles.
    const rustRuns = stepsOf(ci.jobs.rust).map((s) => s.run).filter(Boolean);
    const frontend = rustRuns.indexOf("pnpm build");
    const tests = rustRuns.indexOf("cargo test --workspace");
    // Clippy compiles the workspace too, and any warning fails the job.
    const clippy = rustRuns.indexOf("cargo clippy --workspace --all-targets -- -D warnings");
    expect(frontend).toBeGreaterThanOrEqual(0);
    expect(tests).toBeGreaterThan(frontend);
    expect(clippy).toBeGreaterThan(frontend);
  });
});

describe("build-macos workflow", () => {
  const build = workflow("build-macos.yml");

  it("is call-only and builds the exact requested ref", () => {
    expect(Object.keys(build.on)).toEqual(["workflow_call"]);
    expect(at(build.on, "workflow_call", "inputs", "ref", "required")).toBe(true);
    expect(stepsOf(build.jobs.build)[0].with?.ref).toBe("${{ inputs.ref }}");
  });

  it("builds Apple Silicon natively", () => {
    expect(at(build.jobs.build.strategy, "fail-fast")).toBe(false);
    expect(at(build.jobs.build.strategy, "matrix", "include")).toEqual([
      { runner: "macos-latest", arch: "arm64" },
    ]);
  });

  it("signs updater payloads with the key from the caller's secrets", () => {
    expect(at(build.on, "workflow_call", "secrets", "TAURI_SIGNING_PRIVATE_KEY", "required")).toBe(
      true,
    );
    const step = required(
      stepsOf(build.jobs.build).find((s) => s.name?.startsWith("Build and package")),
      "Build and package step",
    );
    expect(step.env).toEqual({
      TAURI_SIGNING_PRIVATE_KEY: "${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}",
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD:
        "${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}",
    });
    expect(step.run).toContain("--config src-tauri/tauri.release.conf.json");
  });

  it("ships the zip, the updater payload and its signature per arch", () => {
    const upload = required(stepsOf(build.jobs.build).at(-1), "last build step");
    expect(upload.with?.name).toBe("KeepDeck-macos-${{ matrix.arch }}");
    expect(text(at(upload.with, "path"), "the upload step's path").trim().split("\n")).toEqual([
      "KeepDeck-macos-${{ matrix.arch }}.zip",
      "KeepDeck-macos-${{ matrix.arch }}.app.tar.gz",
      "KeepDeck-macos-${{ matrix.arch }}.app.tar.gz.sig",
    ]);
    expect(upload.with?.["if-no-files-found"]).toBe("error");
  });
});

describe("release workflow", () => {
  const release = workflow("release.yml");

  it("is manually dispatchable, defaulting to a published build of main", () => {
    expect(at(release.on, "workflow_dispatch", "inputs", "ref")).toMatchObject({
      required: false,
      default: "main",
    });
    expect(at(release.on, "workflow_dispatch", "inputs", "publish")).toMatchObject({
      type: "boolean",
      required: false,
      default: true,
    });
  });

  it("pins the requested ref once and hands every job the same commit", () => {
    // Without pinning, a manual run's "main" would re-resolve per job — a
    // push landing mid-run would hand tests and builds different code.
    const PINNED = "${{ needs.pin.outputs.sha }}";
    expect(at(release.jobs.pin.outputs, "sha")).toBe("${{ steps.pin.outputs.sha }}");
    expect(release.jobs.test.needs).toBe("pin");
    expect(release.jobs.test.with?.ref).toBe(PINNED);
    expect(release.jobs.build.with?.ref).toBe(PINNED);
    expect(stepsOf(release.jobs.publish)[0].with?.ref).toBe(PINNED);
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
    // The whole point of the split: releasing must never push to the main
    // BRANCH (version accounting). Moving the rolling `latest` tag is fine —
    // and must target exactly the pinned, released commit.
    expect(JSON.stringify(release)).not.toContain(":main");
    const publish = stepNamed(release.jobs.publish, 'Publish the rolling "latest" release');
    expect(publish.run).toContain(
      'git push --force origin "${{ needs.pin.outputs.sha }}:refs/tags/latest"',
    );
  });

  it("composes distinct notes: changelog for the archive, pointer for rolling", () => {
    const checkout = stepsOf(release.jobs.publish)[0];
    expect(checkout.with?.["fetch-depth"]).toBe(0);
    const notes = stepNamed(release.jobs.publish, "Compose the release notes");
    expect(notes.run).toContain("releases/download/latest/latest.json");
    expect(notes.run).toContain("--out notes.md");
    expect(notes.run).toContain("--rolling");
    expect(notes.run).toContain("--out rolling-notes.md");

    // Rolling entry: pointer notes and a title that cannot be mistaken for a
    // versioned release; the changelog lives on the archive alone.
    const publish = stepNamed(release.jobs.publish, 'Publish the rolling "latest" release');
    // Static title and notes — created once, never version-stamped, so the
    // entry sinks down the page as versioned releases stack above it.
    expect(publish.run).toContain('--title "KeepDeck latest"');
    expect(publish.run).not.toContain("KeepDeck latest (");
    expect(publish.run).toContain("--notes-file rolling-notes.md");
    expect(publish.run).not.toContain("--notes-file notes.md");
    // The "Latest" badge belongs to the versioned releases, never to rolling.
    expect(publish.run).toContain("--latest=false");

    const archive = stepNamed(release.jobs.publish, "Archive this version as its own release");
    expect(archive.run).toContain('--title "KeepDeck $VERSION"');
    expect(archive.run).toContain("--notes-file notes.md");
    expect(archive.run).toContain("--latest");
    expect(archive.run).not.toContain("--latest=false");
  });

  it("creates releases only after an explicit REST 404", () => {
    for (const name of [
      'Publish the rolling "latest" release',
      "Archive this version as its own release",
    ]) {
      const step = stepNamed(release.jobs.publish, name);
      expect(step.run).toContain("scripts/github-release-state.mjs");
      expect(step.run).toContain('case "$release_state" in');
      expect(step.run).toContain("exists) ;;");
      expect(step.run).toContain("missing)");
      expect(step.run).not.toContain("gh release view");
    }
  });

  it("archives every version as its own release, badge and manifest stay rolling", () => {
    const archive = stepNamed(release.jobs.publish, "Archive this version as its own release");
    // The permanent history entry: same assets and notes...
    // Bare version, per the repo-wide no-v-prefix rule.
    expect(archive.run).toContain('gh release create "$VERSION"');
    expect(archive.run).not.toContain("v$VERSION");
    expect(archive.run).toContain("--notes-file notes.md");
    expect(archive.run).toContain('--target "${{ needs.pin.outputs.sha }}"');
    expect(archive.run).toContain("assets/KeepDeck-macos-arm64.zip");
    expect(archive.run).toContain("assets/KeepDeck-macos-arm64.app.tar.gz");
    // ...but exactly one latest.json may exist (the rolling release's), and
    // the "Latest" badge stays on the rolling release too.
    expect(archive.run).not.toContain("latest.json");
    // History must never delay what installs and updates consume.
    const steps = stepsOf(release.jobs.publish).map((s) => s.name);
    expect(steps.indexOf("Archive this version as its own release")).toBeGreaterThan(
      steps.indexOf('Publish the rolling "latest" release'),
    );
  });

  it("builds the updater manifest for the Apple Silicon platform", () => {
    const manifest = stepNamed(release.jobs.publish, "Build the updater manifest");
    expect(manifest.run).toContain("scripts/release-manifest.mjs");
    expect(manifest.run).toContain(
      "--payload darwin-aarch64=assets/KeepDeck-macos-arm64.app.tar.gz",
    );
  });

  it("uploads payloads before the manifest, and the manifest last", () => {
    // By name, not position — the version archive step now follows it.
    const publish = stepNamed(release.jobs.publish, 'Publish the rolling "latest" release');
    const script = runOf(publish);
    const lines = script.split("\n");
    const payloadUpload = lines.findIndex((l) =>
      l.includes("gh release upload latest \\"),
    );
    const manifestUpload = lines.findIndex((l) =>
      l.includes("gh release upload latest assets/latest.json --clobber"),
    );
    expect(payloadUpload).toBeGreaterThanOrEqual(0);
    expect(manifestUpload).toBeGreaterThan(payloadUpload);
    // Every asset the manifest points at is uploaded in the first batch.
    const batch = script.slice(0, script.indexOf("latest.json"));
    expect(batch).toContain("assets/KeepDeck-macos-arm64.zip");
    expect(batch).toContain("assets/KeepDeck-macos-arm64.app.tar.gz");
    expect(batch).toContain("assets/KeepDeck-macos-arm64.app.tar.gz.sig");
  });

  it("builds the accumulated changelog only after the version is archived", () => {
    // The changelog is derived from published versioned releases via
    // gh api repos/:repo/releases, so it must follow the archive step — and
    // it uploads to the rolling "latest" release, where the app fetches it.
    const steps = stepsOf(release.jobs.publish).map((s) => s.name);
    const changelog = stepNamed(release.jobs.publish, "Build and upload the accumulated changelog");
    expect(changelog.run).toContain("scripts/release-changelog.mjs");
    expect(changelog.run).toContain("gh release upload latest assets/changelog.json --clobber");
    expect(steps.indexOf("Build and upload the accumulated changelog")).toBeGreaterThan(
      steps.indexOf("Archive this version as its own release"),
    );
    // The just-published version is injected as an authoritative head entry so
    // it survives the releases-list endpoint's read-after-write lag (without
    // it, changelog.json dropped the very version being published).
    expect(changelog.run).toContain("--version");
    expect(changelog.run).toContain("--notes notes.md");
    expect(changelog.env).toMatchObject({ VERSION: "${{ steps.version.outputs.version }}" });
  });
});

describe("version-bump workflow", () => {
  const bump = workflow("version-bump.yml");

  it("queues runs and exposes every manual bump kind", () => {
    expect(bump.concurrency).toEqual({ group: "version-bump", queue: "max" });
    expect(at(bump.on, "workflow_dispatch", "inputs", "bump", "options")).toEqual([
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

    const push = stepNamed(bump.jobs.bump, "Commit and push the bump");
    expect(push.if).toBe("steps.bump.outputs.version != ''");
    expect(push.run).toContain("git push origin HEAD:main");

    const chain = stepNamed(bump.jobs.bump, "Start the release for this bump");
    expect(chain.if).toBe("steps.bump.outputs.release == 'true'");
    // The release must build the exact bump commit, not whatever main is by
    // the time the release run starts.
    expect(chain.run).toBe(
      "gh workflow run release.yml -f ref=${{ steps.push.outputs.sha }}",
    );
  });
});
