/**
 * OpenCode's relocating fork ([F8]) — the exec plumbing around [`rekeyExport`].
 *
 * Native `-s <id> --fork` copies a session but re-homes it to the SOURCE's
 * `directory` (probe-verified, 1.18.4), so the target directory is ignored.
 * The portable recipe is `opencode export → rekey → import`, with one hard
 * constraint learned from probing: **`import` records the session's directory
 * from the CWD it is launched in**, NOT from the JSON's `info.directory`, and a
 * later `-s` resume does NOT rebind it. So the import must run FROM the target
 * directory — which means the target must already exist, and the host
 * guarantees it: a dir target exists up front, and a NEW worktree is
 * provisioned BEFORE this runs (useJournalFork's post-provision step). So
 * `relocatingForkId`'s `targetExists` guard is a safety net, and its native
 * fork fallback fires only on a genuine recipe failure (which it also surfaces).
 *
 * Plugins run in the frontend with no filesystem/spawn of their own: `export`
 * and `import` go through `ctx.services.sessions.spawn` (a PTY, covered by the
 * `exec` capability), and the one temp file `import` needs is written via
 * `ctx.services.fsWrite` into an OS-temp scratch dir the system reaps.
 */
import type {
  ForkPlanInput,
  PluginContext,
  PluginSessionHandle,
} from "@keepdeck/plugin-api";
import { rekeyExport, type OpencodeExport } from "./rekey";

/** OS-temp scratch for the one import file. `/tmp` is auto-reaped and, unlike
 * a fresh subdir under it, canonicalizes consistently for the fsWrite
 * containment check; the manifest declares BOTH this and its macOS
 * `/private/tmp` canonical form. (POSIX-only: a Windows port needs a
 * host-provided temp dir — the plugin has no way to resolve one itself.) */
const SCRATCH_DIR = "/tmp/keepdeck-opencode";

/** Hard cap on one export/import. They are fast (no model/MCP), so this only
 * catches a genuinely stuck process — without it a hung opencode would leave
 * the fork Promise (and the whole fork chain) pending forever. */
const RUN_TIMEOUT_MS = 60_000;

/** Run `opencode <args>` to completion on a host PTY, returning its full
 * output text and exit code. A non-TUI command (export/import) writes plain
 * text; the PTY only maps `\n`→`\r\n` (harmless JSON whitespace). Rejects on a
 * spawn failure or if the process does not exit within `RUN_TIMEOUT_MS`. */
async function runOpencode(
  ctx: PluginContext,
  args: string[],
  cwd?: string,
): Promise<{ text: string; code: number | null }> {
  const chunks: Uint8Array[] = [];
  return new Promise((resolve, reject) => {
    let settled = false;
    let handle: PluginSessionHandle | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      void handle?.close().catch(() => {});
      finish(() =>
        reject(new Error(`opencode ${args[0] ?? ""} timed out after ${RUN_TIMEOUT_MS}ms`)),
      );
    }, RUN_TIMEOUT_MS);
    ctx.services.sessions
      .spawn(
        { command: "opencode", args, ...(cwd ? { cwd } : {}), cols: 120, rows: 40 },
        (event) => {
          if (event.type === "output") chunks.push(event.bytes);
          else finish(() => resolve({ text: decode(chunks), code: event.code }));
        },
      )
      .then((h) => {
        handle = h;
        // The timeout already fired while spawn was in flight — kill the
        // process we just started so it doesn't leak.
        if (settled) void h.close().catch(() => {});
      })
      .catch((e) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))));
  });
}

function decode(chunks: Uint8Array[]): string {
  let total = 0;
  for (const c of chunks) total += c.length;
  const merged = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    merged.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(merged);
}

/** Last chars of a command's output, for an error message. */
const tail = (text: string): string => text.trim().slice(-200);

/** The JSON object out of `opencode export`'s output. A `Exporting session:`
 * line rides ahead of the payload on the PTY, and opencode MAY print a trailing
 * line after it (stdout is a TTY), so scan from the first `{` to its MATCHING
 * `}` — string-aware — rather than a naive first-`{`..last-`}` slice. */
function extractJson(text: string): string {
  const start = text.indexOf("{");
  if (start < 0) throw new Error("opencode export produced no JSON payload");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error("opencode export JSON was truncated or unbalanced");
}

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
    ctx.notify({
      // The host prefixes the plugin name ("OpenCode · …"), so the title omits it.
      title: "Fork opened in the original directory",
      body: "Couldn't relocate the forked session to the chosen folder — it continues where the source ran.",
      severity: "warning",
      workspace: input.workspace,
      tag: `fork-relocate-${input.paneId}`,
    });
    return null;
  }
}
