#!/usr/bin/env node
/**
 * Q1 — a reproducible probe for the four tests that fail only under the full
 * parallel run: three history suites that build a ~9 MB fixture each, and the
 * opencode session reporter's generation test.
 *
 * It does not fix anything and it must not: every run keeps the 5 s budget
 * and adds no retry, because both are the signal. It turns "it flaked once"
 * into a matrix you can hand somebody — seed, pool, workers, repetition,
 * exit status — with the full vitest output kept beside each cell.
 *
 *   node scripts/q1-diagnose.mjs            # all four probes
 *   Q1_SEED=85 Q1_REPS=20 node scripts/q1-diagnose.mjs C   # one probe, tuned
 *
 * Probes — diagnostic, not oracles: on an idle host every one of them has
 * been green, and the only trigger confirmed so far is other suites running
 * on the same machine at the same time. A red cell means "under THIS load";
 * a green one means nothing about a loaded host.
 *   A  the three history suites, parallel forks, three workers, shuffled
 *   B  the same three, one file at a time, one worker
 *   C  the reporter suite alone, N repetitions
 *   D  all four together, parallel (shuffled) and then serial
 *   E  the WHOLE suite, N times, shuffled — the setting that has flaked
 *
 * The seed applies only where files are shuffled (A, D-parallel, E); vitest
 * ignores it otherwise, so a serial cell is in its fixed default order.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HISTORY = [
  "plugins/claude/src/history.test.ts",
  "plugins/codex/src/history.test.ts",
  "plugins/kimi/src/history.test.ts",
];
const REPORTER = "plugins/opencode/src/sessionReporter.test.ts";

const seed = process.env.Q1_SEED ?? "85";
const reps = Number(process.env.Q1_REPS ?? "20");
const only = new Set(process.argv.slice(2).map((s) => s.toUpperCase()));
const wants = (probe) => only.size === 0 || only.has(probe);

const outDir = join(".agents", "q1", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(outDir, { recursive: true });

const vitest = spawnSync("npx", ["vitest", "--version"], { encoding: "utf8" }).stdout.trim();
console.log(
  `q1-diagnose · node ${process.version} · ${vitest} · seed ${seed} (shuffled cells only) · logs in ${outDir}`,
);

/** One vitest run; prints one line and keeps the whole output. */
function run(label, files, flags) {
  const argv = ["vitest", "run", ...files, ...flags];
  const started = Date.now();
  const result = spawnSync("npx", argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const summary = output.match(/Tests\s+.*\(\d+\)/)?.[0] ?? "(no summary)";
  const timeouts = (output.match(/Test timed out/g) ?? []).length;
  // Which of the four this run blamed, by file — the cell of the matrix.
  const blamed = [...HISTORY, REPORTER].filter((file) =>
    new RegExp(`(FAIL|×)[^\\n]*${file.replace(/[/.]/g, "\\$&")}`).test(output),
  );
  writeFileSync(join(outDir, `${label}.log`), `$ npx ${argv.join(" ")}\n\n${output}`);
  console.log(
    `${label.padEnd(14)} exit=${result.status} ${seconds}s  ${summary}` +
      `${timeouts ? `  timeouts=${timeouts}` : ""}${blamed.length ? `  blamed=${blamed.join(",")}` : ""}`,
  );
  return result.status;
}

/** Files shuffled under the seed, so a cell can be re-run in the same order. */
const shuffled = ["--sequence.shuffle", `--sequence.seed=${seed}`];
const parallel = ["--pool=forks", "--maxWorkers=3", "--fileParallelism", ...shuffled];
const serial = ["--no-file-parallelism", "--maxWorkers=1"];

if (wants("A")) run("A-parallel", HISTORY, parallel);
if (wants("B")) run("B-serial", HISTORY, serial);
if (wants("C")) {
  let failures = 0;
  for (let i = 1; i <= reps; i += 1) {
    if (run(`C-rep${String(i).padStart(2, "0")}`, [REPORTER], serial) !== 0) failures += 1;
  }
  console.log(`C              ${failures}/${reps} repetitions failed`);
}
if (wants("D")) {
  run("D-parallel", [...HISTORY, REPORTER], parallel);
  run("D-serial", [...HISTORY, REPORTER], serial);
}
if (wants("E")) {
  const fullReps = Number(process.env.Q1_FULL_REPS ?? "3");
  let failures = 0;
  for (let i = 1; i <= fullReps; i += 1) {
    if (run(`E-full${String(i).padStart(2, "0")}`, [], shuffled) !== 0) failures += 1;
  }
  console.log(`E              ${failures}/${fullReps} full runs failed`);
}
