/**
 * OpenCode's relocating fork ([F8]) — the exec plumbing around [`rekeyExport`].
 *
 * Native `-s <id> --fork` copies a session but re-homes it to the SOURCE's
 * `directory` (probe-verified, 1.18.4), so the target directory is ignored.
 * The portable recipe is `opencode export → rekey → import`, with one hard
 * constraint learned from probing: **`import` records the session's directory
 * from the CWD it is launched in**, NOT from the JSON's `info.directory`, and a
 * later `-s` resume does NOT rebind it. So the import must run FROM the target
 * directory — which means the target must already exist. That holds for a
 * workspace-folder or existing-worktree target; a not-yet-provisioned worktree
 * is handled by the caller (native fork fallback until [[provision-first]]).
 *
 * Plugins run in the frontend with no filesystem/spawn of their own: `export`
 * and `import` go through `ctx.services.sessions.spawn` (a PTY, covered by the
 * `exec` capability), and the one temp file `import` needs is written via
 * `ctx.services.fsWrite` into an OS-temp scratch dir the system reaps.
 */
import type { ForkPlanInput, PluginContext } from "@keepdeck/plugin-api";
import { rekeyExport, type OpencodeExport } from "./rekey";

/** OS-temp scratch for the one import file. `/tmp` is auto-reaped and, unlike
 * a fresh subdir under it, canonicalizes consistently for the fsWrite
 * containment check; the manifest declares BOTH this and its macOS
 * `/private/tmp` canonical form. */
const SCRATCH_DIR = "/tmp/keepdeck-opencode";

/** Run `opencode <args>` to completion on a host PTY, returning its full
 * output text and exit code. A non-TUI command (export/import) writes plain
 * text; the PTY only maps `\n`→`\r\n` (harmless JSON whitespace). */
async function runOpencode(
  ctx: PluginContext,
  args: string[],
  cwd?: string,
): Promise<{ text: string; code: number | null }> {
  const chunks: Uint8Array[] = [];
  return new Promise((resolve, reject) => {
    ctx.services.sessions
      .spawn({ command: "opencode", args, ...(cwd ? { cwd } : {}), cols: 120, rows: 40 }, (event) => {
        if (event.type === "output") chunks.push(event.bytes);
        else resolve({ text: decode(chunks), code: event.code });
      })
      .catch(reject);
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

/** The JSON object out of `opencode export`'s output — a `Exporting session:`
 * line on stderr rides ahead of the payload on the PTY, so take the span from
 * the first `{` to the last `}`. */
function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("opencode export produced no JSON payload");
  }
  return text.slice(start, end + 1);
}

/**
 * Fork `input.sessionId` INTO `input.cwd` by export→rekey→import, returning the
 * new session's id (resume it with `-s <id>`, no `--fork`). Throws — leaving the
 * store untouched — if any step fails; the import is the only mutation and it is
 * a single atomic opencode command. The caller must ensure `input.cwd` exists.
 */
export async function opencodeForkPlan(
  ctx: PluginContext,
  input: ForkPlanInput,
): Promise<string> {
  const exportRun = await runOpencode(ctx, ["export", input.sessionId], input.cwd);
  const exported = JSON.parse(extractJson(exportRun.text)) as OpencodeExport;

  const { rekeyed, newSessionId } = rekeyExport(exported, { directory: input.cwd });

  const file = `${SCRATCH_DIR}/fork-${crypto.randomUUID()}.json`;
  await ctx.services.fsWrite.writeFile(file, JSON.stringify(rekeyed));

  // Run FROM the target: import binds the session's directory to this cwd.
  const importRun = await runOpencode(ctx, ["import", file], input.cwd);
  if (!importRun.text.includes(newSessionId)) {
    throw new Error(
      `opencode import did not confirm ${newSessionId}: ${importRun.text.trim().slice(-200)}`,
    );
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
