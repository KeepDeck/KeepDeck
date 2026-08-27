/**
 * OpenCode's relocating fork: the recipe, and what a failed one should mean.
 *
 * Running the commands and reading their output is [`exec.ts`]'s, and the
 * transformation between them is [`rekeyExport`]'s. What is left here is the
 * order of the steps, the one temp file they hand each other, and the ruling
 * on a failure — which of them the user is told about and in what words.
 *
 * Native `-s <id> --fork` copies a session but re-homes it to the SOURCE's
 * `directory` (probe-verified, 1.18.4), so the target directory is ignored.
 * The portable recipe is `opencode export → rekey → import`, with one hard
 * constraint learned from probing: **`import` records the session's directory
 * from the CWD it is launched in**, NOT from the JSON's `info.directory`, and a
 * later `-s` resume does NOT rebind it. So the import must run FROM the target
 * directory — which means the target must already exist, and the host
 * guarantees it: a dir target exists up front, and a NEW worktree is
 * provisioned BEFORE this runs (the host's post-provision step). So
 * `relocatingForkId`'s `targetExists` guard is a safety net, and its native
 * fork fallback fires only on a genuine recipe failure (which it also surfaces).
 *
 * Plugins run in the frontend with no filesystem/spawn of their own: `export`
 * and `import` go through `ctx.services.sessions.spawn` (a PTY, covered by the
 * `exec` capability), and the one temp file `import` needs is written via
 * `ctx.services.fsWrite` into an OS-temp scratch dir the system reaps.
 */
import type { ForkPlanInput, PluginContext } from "@keepdeck/plugin-api";
import { extractJson, runOpencode, tail } from "./exec";
import { rekeyExport, type OpencodeExport } from "./rekey";

/** OS-temp scratch for the one import file. `/tmp` is auto-reaped and, unlike
 * a fresh subdir under it, canonicalizes consistently for the fsWrite
 * containment check; the manifest declares BOTH this and its macOS
 * `/private/tmp` canonical form. (POSIX-only: a Windows port needs a
 * host-provided temp dir — the plugin has no way to resolve one itself.) */
const SCRATCH_DIR = "/tmp/keepdeck-opencode";

/**
 * Fork `input.sessionId` INTO `input.cwd` by export→rekey→import, returning the
 * new session's id (resume it with `-s <id>`, no `--fork`). Throws — leaving the
 * store untouched — if any step fails; the import is the only mutation and it is
 * a single atomic opencode command. The caller (`relocatingForkId`) guarantees
 * `input.cwd` exists and converts a throw into the native-fork fallback.
 */
export async function opencodeForkPlan(
  ctx: PluginContext,
  input: ForkPlanInput,
): Promise<string> {
  const exportRun = await runOpencode(ctx, ["export", input.sessionId], input.cwd);
  // Exit code is authoritative. A null code (the PTY couldn't report one) is
  // tolerated here because a failed export can't survive extractJson/JSON.parse
  // below — unlike import, which has no downstream validator and so ALSO checks
  // the id echo when the code is null (see the import gate).
  if (exportRun.code !== 0 && exportRun.code !== null) {
    throw new Error(`opencode export exited ${exportRun.code}: ${tail(exportRun.text)}`);
  }
  const exported = JSON.parse(extractJson(exportRun.text)) as OpencodeExport;

  const { rekeyed, newSessionId } = rekeyExport(exported, { directory: input.cwd });

  // One file per pane (overwritten on re-fork), not an unbounded pile of uuid
  // files — /tmp is world-readable and only OS-reaped.
  const file = `${SCRATCH_DIR}/fork-${input.paneId}.json`;
  await ctx.services.fsWrite.writeFile(file, JSON.stringify(rekeyed));

  try {
    // Run FROM the target: import binds the session's directory to this cwd.
    const importRun = await runOpencode(ctx, ["import", file], input.cwd);
    // The exit code is authoritative; the id echo is a secondary check only when
    // the PTY could not report a code. A substring match ALONE cannot tell a full
    // import from a header-only / dedup-emptied one, so it is never the sole gate.
    const ok =
      importRun.code === 0 ||
      (importRun.code === null && importRun.text.includes(newSessionId));
    if (!ok) {
      throw new Error(`opencode import failed (exit ${importRun.code}): ${tail(importRun.text)}`);
    }
    return newSessionId;
  } finally {
    // The scratch held the WHOLE conversation. Its purpose ends with the
    // import, so it does not outlive it — on the failure path either, where
    // the transcript would otherwise sit in /tmp until the OS reaped it. The
    // write capability has no unlink, so the content is overwritten; the file
    // itself is created 0600 by the host.
    await ctx.services.fsWrite
      .writeFile(file, "{}")
      .catch((cause: unknown) =>
        ctx.log.warn(
          `could not clear the fork scratch ${file}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        ),
      );
  }
}

/** Whether the fork target already exists on disk — a not-yet-provisioned
 * worktree does not, and the relocating recipe (import-from-target) can't run
 * for it. Cheap: one non-recursive directory listing, existence by success. */
export async function targetExists(
  ctx: PluginContext,
  path: string,
): Promise<boolean> {
  try {
    await ctx.services.fs.readDir(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The relocating fork's decision point: the new session id to resume, or `null`
 * when the caller should fall back to native `-s <id> --fork`. NEVER throws — a
 * not-yet-provisioned worktree target, OR any failure in the export→import
 * recipe (a hiccup, a timeout, opencode drift), degrades to the native fork
 * (logged) instead of hard-failing the whole fork, which is what a bare throw
 * out of `fork.plan` would do.
 */
export async function relocatingForkId(
  ctx: PluginContext,
  input: ForkPlanInput,
): Promise<string | null> {
  // Benign: a not-yet-provisioned worktree target. Native fork, no alarm.
  if (!(await targetExists(ctx, input.cwd))) return null;
  try {
    return await opencodeForkPlan(ctx, input);
  } catch (e) {
    // A GENUINE recipe failure on a target that DOES exist (opencode drift, a
    // timeout, an export/import error) — distinct from the benign case above.
    // Native fork silently re-homes the copy to the SOURCE dir, so surface it:
    // the user asked to relocate and it didn't. Still fall back (a fork happens)
    // rather than hard-failing the whole fork.
    ctx.log.warn(
      `opencode fork relocation of ${input.sessionId} failed — native --fork fallback: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    try {
      ctx.notify({
        // Host prefixes the plugin name ("OpenCode · …"), so the title omits it.
        title: "Fork opened in the original directory",
        body: "Couldn't relocate the forked session to the chosen folder — it continues where the source ran.",
        severity: "warning",
        workspace: input.workspace,
        tag: `fork-relocate-${input.paneId}`,
      });
    } catch {
      // Best-effort: a notify failure must not turn the benign native fallback
      // into a thrown fork.plan (relocatingForkId's "never throws" contract).
    }
    return null;
  }
}
