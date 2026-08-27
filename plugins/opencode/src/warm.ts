/**
 * Bootstrapping this CLI's config dir before a pane has to wait for it.
 *
 * opencode treats `OPENCODE_CONFIG_DIR` as its own writable home: on first
 * use it installs its plugin `node_modules` there, and a pane that spawns
 * into a cold dir sits through that install with nothing to show for it —
 * measured at 15 s alone, and 40-55 s when several panes of one team reach
 * the same dir at once and each starts its own.
 *
 * All of that is THIS CLI's business, so all of it lives here: what a
 * finished install looks like, what to run to produce one, and when it is
 * worth running. The host is asked only to perform the run — bounded, and
 * one at a time per dir — and never learns whose install it is.
 *
 * The dir is also where an interrupted install leaves a tree that opencode
 * itself neither notices nor repairs (measured: it loads the partial state
 * silently and boots no slower). Warming refuses such a tree rather than
 * furnishing over it — it is somebody's lived-in home, and overwriting it
 * is not a decision a background job gets to make.
 */
import type { PluginContext } from "@keepdeck/plugin-api";

/** What one look at the dir concluded. */
export type TreeHealth =
  /** No manifest — opencode has never bootstrapped this dir. */
  | { state: "absent" }
  /** A manifest, but nothing installed against it yet. */
  | { state: "empty" }
  /** Every installed entry carries its provenance. */
  | { state: "healthy" }
  /** An install that did not finish, or a tree since damaged. */
  | { state: "broken" };

/** The manifest opencode writes into its config dir. Only the pin is read;
 * the file is otherwise none of our business. */
const MANIFEST = "package.json";
/** npm's own record of what it installed, hidden inside the tree. It is the
 * only place that says whether every package was fully written. */
const PROVENANCE = "node_modules/.package-lock.json";

async function readJson(
  ctx: PluginContext,
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    const file = await ctx.services.fs.readFile(path);
    if (typeof file.text !== "string") return null;
    return JSON.parse(file.text) as Record<string, unknown>;
  } catch {
    // Absent, unreadable or unparseable all mean the same thing to every
    // caller here: we cannot vouch for this file.
    return null;
  }
}

/**
 * Read the dir's condition. A pure read — no lock, no writes, no opencode.
 *
 * The rule is provenance COVERAGE, not a file or directory count: counts
 * vary by platform and optional dependencies, while a finished install
 * writes `resolved` and `integrity` for every entry it recorded. The real
 * damaged tree that prompted this carried them on 1 entry of 27.
 */
export async function treeHealth(
  ctx: PluginContext,
  dir: string,
): Promise<TreeHealth> {
  const manifest = await readJson(ctx, `${dir}/${MANIFEST}`);
  if (!manifest) return { state: "absent" };
  const lock = await readJson(ctx, `${dir}/${PROVENANCE}`);
  if (!lock) {
    // A manifest with no provenance is either an install that has not
    // started or one caught mid-write; neither is ours to tell apart, and
    // both answer the same question the same way: it is not finished.
    return { state: "empty" };
  }
  const packages = lock.packages;
  if (typeof packages !== "object" || packages === null) return { state: "broken" };
  const entries = Object.entries(packages as Record<string, unknown>);
  const covered = entries.every(([name, entry]) => {
    // The root key ("") describes the dir itself, not a download, and has
    // no provenance to carry.
    if (name === "") return true;
    if (typeof entry !== "object" || entry === null) return false;
    const record = entry as Record<string, unknown>;
    // Present but empty is an install that never finished writing it.
    return (
      typeof record.resolved === "string" &&
      record.resolved.length > 0 &&
      typeof record.integrity === "string" &&
      record.integrity.length > 0
    );
  });
  return { state: covered ? "healthy" : "broken" };
}

/**
 * Make sure `dir` is fit for a pane to boot against, and never throw.
 *
 * A skipped warm-up is an optimization not taken; a thrown one would fail
 * the plan that called it and card the pane over nothing worse. So every
 * failure here — an unreadable dir, a missing CLI, a refused run — costs a
 * log line and today's un-warmed boot.
 *
 * Concurrency is the host's: two panes of one workspace reaching this at
 * the same moment both ask, and the run they get is the same run. That is
 * why there is no "already warmed" memory here — the dir's own condition
 * answers it, and a memory would go on answering after the dir changed.
 */
export async function warmConfigDir(
  ctx: PluginContext,
  dir: string,
): Promise<void> {
  try {
    const health = await treeHealth(ctx, dir);
    if (health.state === "healthy") return;
    if (health.state === "broken") {
      ctx.log.warn(
        `config dir looks half-installed, leaving it alone: ${dir}`,
      );
      return;
    }
    const outcome = await ctx.services.exec.runOnce({
      // Keyed on the DIR: panes and sessions come and go, the dir is the
      // resource two of them would otherwise install into at once.
      key: dir,
      command: "opencode",
      // A cheap non-interactive command. Anything that makes opencode load
      // its config dir bootstraps it; this one prints a list and exits.
      args: ["models"],
      env: [["OPENCODE_CONFIG_DIR", dir]],
    });
    if (!outcome.ok) {
      ctx.log.warn(`config warm-up failed, booting cold: ${outcome.said}`);
    }
  } catch (error) {
    ctx.log.warn(`config warm-up skipped: ${error}`);
  }
}
