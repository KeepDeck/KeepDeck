/**
 * OpenCode's relocating fork: the order of its steps, the one temp file they
 * hand each other, and what a failure means.
 *
 * opencode's own `--fork` keeps the copy in the SOURCE session's directory
 * (probe-verified, 1.18.4), and 2.x has none at all. So a fork is
 * `export → rekey → import`, run FROM the target directory, on both
 * generations; what differs between them — the commands, the document, how
 * each answer is read — is a recipe's (forkRecipe.ts), and this file knows
 * no command of either.
 *
 * A fork lands in the target or does not happen (the user's decision,
 * task-378). Every failure is a refusal: no pane is opened, the alert says
 * why. There is no fallback to opencode's own `--fork`, which would open the
 * copy in the source's checkout from a pane filed under another team — the
 * one outcome a fork into a directory exists to prevent.
 *
 * Plugins run in the frontend with no filesystem or spawn of their own: the
 * commands go through the host's PTY (exec.ts), and the one temp file the
 * import reads is written through `fsWrite` into an OS-temp scratch dir.
 */
import {
  errorMessage,
  type ForkPlanInput,
  type PluginFs,
  type PluginFsWrite,
  type PluginLogger,
} from "@keepdeck/plugin-api";
import { runOpencode, type ExecPorts } from "./exec";
import type { ForkRecipe } from "./forkRecipe";

/** OS-temp scratch for the one import file. `/tmp` is auto-reaped and, unlike
 * a fresh subdir under it, canonicalizes consistently for the fsWrite
 * containment check; the manifest declares BOTH this and its macOS
 * `/private/tmp` canonical form. (POSIX-only: a Windows port needs a
 * host-provided temp dir — the plugin has no way to resolve one itself.) */
const SCRATCH_DIR = "/tmp/keepdeck-opencode";

/** How long a read-back waits before its one retry: 1.x answered `database
 * is locked` to an export run right after its import (measured, 1.19.3). */
const VERIFY_RETRY_MS = 250;

/** What a fork needs from the host. */
export interface ForkPorts extends ExecPorts {
  log: Pick<PluginLogger, "warn">;
  services: ExecPorts["services"] & {
    fs: Pick<PluginFs, "readDir">;
    fsWrite: Pick<PluginFsWrite, "writeFile" | "remove">;
  };
}

/** What a fork is told to do, and the words for a session the pane's
 * opencode does not have. */
export type ForkRequest = Pick<ForkPlanInput, "paneId" | "cwd" | "sessionId"> & {
  missing: string;
};

/**
 * Fork `request.sessionId` INTO `request.cwd` by the recipe, answering the
 * new session's id. Throws on every failure, in words for the user — the
 * host's alert shows them; the source session is never written to.
 */
export async function forkInto<Document>(
  ports: ForkPorts,
  recipe: ForkRecipe<Document>,
  request: ForkRequest,
): Promise<string> {
  const { cwd, sessionId } = request;
  const refuse = (words: string, detail?: string): never => {
    ports.log.warn(`opencode fork of ${sessionId} into ${cwd} refused: ${detail ?? words}`);
    throw new Error(words);
  };
  const failedCopy = (detail: string) => refuse(`The copy failed: ${detail}`, detail);
  /** A command run in the target; one that could not run or never ended is
   * a failed copy like any other. */
  const run = async (args: readonly string[]) => {
    try {
      return await runOpencode(ports, args, cwd);
    } catch (cause) {
      return failedCopy(errorMessage(cause));
    }
  };

  // The host provisions a fork's target before this runs (a new worktree
  // too), so a missing one is a fault — never a reason to fork elsewhere.
  if (!(await targetExists(ports, cwd))) return refuse(`The fork target ${cwd} does not exist.`);

  const exported = recipe.readExport(await run(recipe.exportArgs(sessionId)));
  if (exported.kind === "missing") return refuse(request.missing);
  if (exported.kind === "failed") return failedCopy(exported.detail);

  let clone;
  try {
    clone = recipe.rekey(exported.document, cwd);
  } catch (cause) {
    return failedCopy(errorMessage(cause));
  }
  // An import of the source's own id rewrites the SOURCE (measured, 1.x).
  if (clone.newSessionId === sessionId) return failedCopy("the clone kept the source's id");

  // One file per pane (overwritten on re-fork), not a pile of uuid files.
  const file = `${SCRATCH_DIR}/fork-${request.paneId}.json`;
  await ports.services.fsWrite.writeFile(file, JSON.stringify(clone.document));
  try {
    const imported = recipe.readImport(
      await run(recipe.importArgs(file, cwd)),
      clone.newSessionId,
    );
    if (imported.kind === "failed") return failedCopy(imported.detail);
    if (imported.kind === "claimed") {
      const { verify } = recipe;
      if (!verify) return failedCopy("the import was not confirmed");
      const readBack = async () =>
        verify.read(await run(verify.args(clone.newSessionId)), clone, cwd);
      let check = await readBack();
      if (!check.ok) {
        await new Promise((resolve) => setTimeout(resolve, VERIFY_RETRY_MS));
        check = await readBack();
      }
      if (!check.ok) return failedCopy(check.detail);
    }
    return clone.newSessionId;
  } finally {
    // The scratch held the WHOLE conversation; its purpose ends with the
    // import, on the failure path too.
    await ports.services.fsWrite
      .remove(file)
      .catch((cause: unknown) =>
        ports.log.warn(`could not remove the fork scratch ${file}: ${errorMessage(cause)}`),
      );
  }
}

/** Whether the fork target exists on disk. Cheap: one non-recursive
 * directory listing, existence by success. */
async function targetExists(ports: ForkPorts, path: string): Promise<boolean> {
  try {
    await ports.services.fs.readDir(path);
    return true;
  } catch {
    return false;
  }
}
