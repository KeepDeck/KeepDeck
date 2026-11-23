import {
  isJsonRecord,
  sha256Hex,
  type ForkPlanInput,
  type PluginFs,
  type PluginFsWrite,
} from "@keepdeck/plugin-api";
import { rebaseState, rebaseWire } from "./forkRebase";

/** What a fork needs from the host: reading the source session, and the
 * store surgery that writes its clone. */
export interface ForkPorts {
  services: {
    fs: Pick<PluginFs, "readDir" | "readFile">;
    fsWrite: Pick<PluginFsWrite, "writeFile" | "copyFile" | "appendLine" | "remove">;
  };
}

/** A fork made: the session it opens, and its clone — everything the fork
 * leaves in kimi's store besides an index line, which kimi skips once the
 * clone is gone. */
export interface KimiFork {
  sessionId: string;
  clone: string;
}

/**
 * Kimi's cross-directory fork ([F8], probe-verified on kimi 0.27, re-verified
 * on 2.2.0):
 *
 * A session lives at `<home>/sessions/wd_<key>/session_<id>/` — `state.json`,
 * `agents/<name>/wire.jsonl` per agent, blobs, logs. `kimi --session <id>`
 * resolves the id via the global `session_index.jsonl`.
 *
 * A non-destructive fork is a clone under a fresh id: copy the session dir
 * into the TARGET cwd's `wd_` folder, rebase what names the old place
 * (`forkRebase.ts` owns which records and why), and append the new id to the
 * index. The original stays resumable where it was. The `wd_` key is
 * `wd_<slug-of-basename>_<sha256(cwd)[:12]>`, derived as kimi derives it
 * ([`wdKey`]).
 *
 * The key's shape and its derivation are both kimi's own, in kimi's source
 * (`packages/agent-core-v2/src/_base/utils/workdir-slug.ts`), and
 * `session_index.jsonl` is still the index it files ids in. The layout gate
 * below catches a store whose layout moved.
 */
export async function kimiForkPlan(
  ctx: ForkPorts,
  input: ForkPlanInput,
): Promise<KimiFork> {
  const wire = input.transcriptPath;
  if (!wire) {
    throw new Error(
      `kimi fork of ${input.sessionId}: no recorded transcript path`,
    );
  }
  // …/sessions/wd_<key>/session_<id>/agents/main/wire.jsonl — the store root
  // is derived from the recorded path, never guessed, so a layout change
  // fails LOUDLY here. (History lists a KIMI_CODE_HOME store too, but a
  // fork of one is refused when it writes: writes are containment-scoped to
  // the manifest's ~/.kimi-code prefix, and a variable widens no write.)
  const match = wire.match(/^(.*\/sessions)\/(wd_[^/]+)\/(session_[^/]+)\/agents\/main\/wire\.jsonl$/);
  if (!match || match[3] !== input.sessionId) {
    throw new Error(
      `kimi fork of ${input.sessionId}: unexpected store layout (${wire})`,
    );
  }
  const [, sessionsRoot, , sessionDirName] = match;
  const srcSessionDir = `${sessionsRoot}/${match[2]}/${sessionDirName}`;

  const stateFile = await ctx.services.fs.readFile(`${srcSessionDir}/state.json`);
  if (stateFile.text === null || stateFile.truncated) {
    throw new Error(
      `kimi fork of ${input.sessionId}: state.json is unreadable`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stateFile.text);
  } catch {
    throw new Error(`kimi fork of ${input.sessionId}: state.json is not JSON`);
  }
  if (!isJsonRecord(parsed)) {
    throw new Error(`kimi fork of ${input.sessionId}: state.json is not a JSON object`);
  }
  const state = parsed;

  const newId = `session_${crypto.randomUUID()}`;
  const workspaceId = await wdKey(input.cwd);
  const dstSessionDir = `${sessionsRoot}/${workspaceId}/${newId}`;
  const rebased = rebaseState(state, {
    cwd: input.cwd,
    sessionId: newId,
    sessionDir: dstSessionDir,
  });
  if (!rebased) {
    throw new Error(
      `kimi fork of ${input.sessionId}: state.json misses workDir/cwd or agents.main.homedir — layout changed?`,
    );
  }
  const { workDirKey } = rebased;

  // Write order is the contract: the artifacts that ACTIVATE a session
  // (state.json — the resume gate — and the index line) land LAST, after the
  // conversation files. A failure before the index line takes the clone back
  // out — throwing leaves the store as it was — and none can leave a
  // half-alive session.
  try {
    await clone(ctx, { srcSessionDir, dstSessionDir, workspaceId, state: rebased.state, workDirKey }, input);
  } catch (error) {
    await ctx.services.fsWrite.remove(dstSessionDir).catch(() => {});
    throw error;
  }

  // The index is how `--session <id>` finds the clone at all. Its line keeps
  // the name `workDir` whatever the state file calls it: the index has its
  // own schema, and kimi refuses a line that does not carry that key.
  const indexPath = `${sessionsRoot.slice(0, -"/sessions".length)}/session_index.jsonl`;
  await ctx.services.fsWrite.appendLine(
    indexPath,
    JSON.stringify({
      sessionId: newId,
      sessionDir: dstSessionDir,
      workDir: input.cwd,
    }),
  );
  return { sessionId: newId, clone: dstSessionDir };
}

/** Lay the clone out and read it back — everything before the index line. */
async function clone(
  ctx: ForkPorts,
  at: { srcSessionDir: string; dstSessionDir: string; workspaceId: string; state: unknown; workDirKey: string },
  input: ForkPlanInput,
): Promise<void> {
  const { srcSessionDir, dstSessionDir, workspaceId, state, workDirKey } = at;
  // The clone is the WHOLE session dir, not a fixed file list: real sessions
  // carry blobs/ (pasted images the wire references by blobref:), tasks/,
  // plans/ and agents/agent-N/ subagent trees — a wire-only copy would
  // dangle. state.json is skipped here (the rebased version lands last).
  await copyTree(ctx, srcSessionDir, dstSessionDir, workspaceId);
  await ctx.services.fsWrite.writeFile(`${dstSessionDir}/state.json`, JSON.stringify(state, null, 2));

  // Read the clone back before the index line makes it findable: a session
  // that exists with a real id but opens elsewhere is the failure nobody can
  // see. Refusing HERE needs no cleanup of the index — the append is the
  // commit point, and taking a line back out of a journal a live kimi may be
  // reading is the dangerous move we then never make.
  //
  // Proves our write landed; NOT that kimi resolves the session here — the
  // `wd_` derivation is ours (module docblock), and only a resume proves that.
  const landed = await ctx.services.fs.readFile(`${dstSessionDir}/state.json`);
  const landedWorkDir =
    landed.text === null || landed.truncated
      ? null
      : ((): unknown => {
          try {
            // The same key the patch wrote — reading the other one would
            // report "an unreadable state" for a clone that is perfectly fine.
            const written: unknown = JSON.parse(landed.text);
            return isJsonRecord(written) ? written[workDirKey] : null;
          } catch {
            return null;
          }
        })();
  if (landedWorkDir !== input.cwd) {
    throw new Error(
      `kimi fork of ${input.sessionId}: the clone landed in ${
        typeof landedWorkDir === "string" ? landedWorkDir : "an unreadable state"
      }, not ${input.cwd} — not activating it`,
    );
  }
}

/** Copy every file under `srcDir` into the mirrored path under `dstDir`,
 * EXCEPT the top-level `state.json` (its rebased version is written last —
 * it is the activation artifact). Each agent's `wire.jsonl` is rewritten
 * rather than copied: it names the workspace the agent runs in. Depth-first
 * via the read `fs` capability; symlinks are skipped (kimi's store has none,
 * and following one out of the store would be refused by write containment
 * anyway). */
async function copyTree(
  ctx: ForkPorts,
  srcDir: string,
  dstDir: string,
  workspaceId: string,
  relative = "",
): Promise<void> {
  const entries = await ctx.services.fs.readDir(srcDir);
  for (const entry of entries) {
    const dst = `${dstDir}/${entry.name}`;
    const path = `${relative}${entry.name}`;
    if (entry.kind === "dir") {
      await copyTree(ctx, entry.path, dst, workspaceId, `${path}/`);
    } else if (entry.kind === "file") {
      if (path === "state.json") continue;
      const agent = path.match(/^agents\/([^/]+)\/wire\.jsonl$/)?.[1];
      if (agent === undefined) {
        await ctx.services.fsWrite.copyFile(entry.path, dst);
      } else {
        const text = await readWholeText(ctx, entry.path);
        await ctx.services.fsWrite.writeFile(dst, rebaseWire(text, agent, workspaceId));
      }
    }
  }
}

/** A whole file as text, window by window — a wire outgrows any single read.
 * The host ends each window on a character boundary and says where
 * (`readBytes`), so the next window starts exactly there. */
async function readWholeText(ctx: ForkPorts, path: string): Promise<string> {
  let text = "";
  let offset = 0;
  for (;;) {
    // As large a window as the host will give: `maxBytes` is a request the
    // host clamps to its own ceiling, and `readBytes` says what it gave.
    const window = await ctx.services.fs.readFile(path, {
      maxBytes: Number.MAX_SAFE_INTEGER,
      offset,
    });
    if (window.text === null || (window.truncated && window.readBytes === 0)) {
      throw new Error(`kimi fork: ${path} is unreadable`);
    }
    text += window.text;
    if (!window.truncated) return text;
    offset += window.readBytes;
  }
}

/** A directory name as kimi slugs it for its store folder: lowercased, a run
 * of anything outside `[a-z0-9._-]` made ONE dash, dashes trimmed off both
 * ends before and after the cut to forty characters, and "workspace" for
 * what comes out empty, "." or "..". */
function slugOfBasename(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return slug === "" || slug === "." || slug === ".." ? "workspace" : slug;
}

/** `wd_<slug>_<sha256(path)[:12]>` — the store folder kimi files a
 * directory's sessions under, as kimi's own `encodeWorkDirKey` derives it
 * (packages/agent-core-v2/src/_base/utils/workdir-slug.ts; the same rule
 * since kimi 2.2.0). The path is normalized first — backslashes made
 * slashes, trailing slashes dropped — and the slug and the digest both read
 * the normalized path, so a directory named with or without a trailing slash
 * files in one place. A folder named with spaces, non-Latin letters or a
 * long name otherwise lands where kimi never looks, with no error to say so.
 *
 * kimi keys a directory by its REAL path; this reads the deck's path as it
 * is, so a directory reached through a symlink keys apart from kimi's. */
export async function wdKey(cwd: string): Promise<string> {
  const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return `wd_${slugOfBasename(base)}_${(await sha256Hex(normalized)).slice(0, 12)}`;
}
