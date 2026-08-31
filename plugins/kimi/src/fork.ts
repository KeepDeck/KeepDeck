import type { ForkPlanInput, PluginContext } from "@keepdeck/plugin-api";

/**
 * Kimi's cross-directory fork ([F8], probe-verified on kimi 0.27):
 *
 * A session lives at `<home>/sessions/wd_<key>/session_<id>/` as exactly
 * three files — `state.json`, `agents/main/wire.jsonl`, `logs/kimi-code.log`
 * — with the id and every path embedded ONLY in `state.json`. `kimi
 * --session <id>` resolves the id via the global `session_index.jsonl`.
 *
 * The working directory lives under DIFFERENT KEYS in different eras of the
 * store: older sessions carry `workDir`, sessions written since kimi 0.38
 * carry `cwd` instead. Read either, and write back whichever the source
 * used — inventing the other key would put a field in the clone that the
 * era it belongs to never had.
 *
 * A non-destructive fork is therefore a three-file clone under a fresh id:
 * copy the session dir into the TARGET cwd's `wd_` folder, patch `workDir`
 * (the gate) and `agents.main.homedir` (the one embedded absolute path),
 * and append the new id to the index. The original stays resumable where
 * it was. The `wd_` key is `wd_<lowercased-basename>_<sha256(cwd)[:12]>`.
 *
 * Its SHAPE is now upstream's own contract — kimi-code 0.38 validates
 * `^wd_[a-z0-9._-]+_[0-9a-f]{12}$` in `packages/protocol/src/workspace.ts`
 * ("workspace_id must be a wd_<slug>_<hash12> string"), and
 * `session_index.jsonl` is still the index it files ids in
 * (`packages/migration-legacy/src/paths.ts`). The DERIVATION — which
 * basename, lowercased, over which digest of which path — is published
 * nowhere and stays probe-derived: a validator that accepts our output
 * proves the string is well-formed, never that it names the directory
 * kimi would have picked. The layout gate below is what catches that.
 */
export async function kimiForkPlan(
  ctx: PluginContext,
  input: ForkPlanInput,
): Promise<string> {
  const wire = input.transcriptPath;
  if (!wire) {
    throw new Error(
      `kimi fork of ${input.sessionId}: no recorded transcript path`,
    );
  }
  // …/sessions/wd_<key>/session_<id>/agents/main/wire.jsonl — the store root
  // is derived from the recorded path, never guessed, so a layout change
  // fails LOUDLY here. (A KIMI_CODE_HOME override still can't fork: writes
  // are containment-scoped to the manifest's ~/.kimi-code prefix — and
  // discovery wouldn't list such sessions anyway.)
  const match = wire.match(/^(.*\/sessions)\/(wd_[^/]+)\/(session_[^/]+)\/agents\/main\/wire\.jsonl$/);
  if (!match || match[3] !== input.sessionId) {
    throw new Error(
      `kimi fork of ${input.sessionId}: unexpected store layout (${wire})`,
    );
  }
  const [, sessionsRoot, , sessionDirName] = match;
  const srcSessionDir = `${sessionsRoot}/${match[2]}/${sessionDirName}`;

  // The state file is the only file embedding identity — read, verify, patch.
  const stateFile = await ctx.services.fs.readFile(`${srcSessionDir}/state.json`);
  if (stateFile.text === null || stateFile.truncated) {
    throw new Error(
      `kimi fork of ${input.sessionId}: state.json is unreadable`,
    );
  }
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(stateFile.text) as Record<string, unknown>;
  } catch {
    throw new Error(`kimi fork of ${input.sessionId}: state.json is not JSON`);
  }
  const agents = state.agents as
    | { main?: { homedir?: unknown } }
    | undefined;
  // Which key this era of the store used. Requiring `workDir` alone made
  // every session written since kimi 0.38 unforkable — the gate fired
  // loudly, as designed, on a layout that had merely been renamed.
  const workDirKey =
    typeof state.workDir === "string"
      ? "workDir"
      : typeof state.cwd === "string"
        ? "cwd"
        : null;
  if (workDirKey === null || typeof agents?.main?.homedir !== "string") {
    throw new Error(
      `kimi fork of ${input.sessionId}: state.json misses workDir/cwd or agents.main.homedir — layout changed?`,
    );
  }

  const newId = `session_${crypto.randomUUID()}`;
  const dstSessionDir = `${sessionsRoot}/${await wdKey(input.cwd)}/${newId}`;

  // Write order is the contract: the artifacts that ACTIVATE a session
  // (state.json — the resume gate — and the index line) land LAST, after the
  // conversation files. A failure mid-sequence then leaves only inert files
  // kimi never discovers — never a half-alive session.
  //
  // The clone is the WHOLE session dir, not a fixed file list: real sessions
  // carry blobs/ (pasted images the wire references by blobref:), tasks/,
  // plans/ and agents/agent-N/ subagent trees — a wire-only copy would
  // dangle. state.json is skipped here (the patched version lands last).
  await copyTree(ctx, srcSessionDir, dstSessionDir);
  const patched = {
    ...state,
    // The key the source used, not both: a clone that carries a field its
    // own era never wrote is a clone that lies about which era it is.
    [workDirKey]: input.cwd,
    agents: {
      ...(state.agents as Record<string, unknown>),
      main: {
        ...(agents.main as Record<string, unknown>),
        homedir: `${dstSessionDir}/agents/main`,
      },
    },
  };
  await ctx.services.fsWrite.writeFile(
    `${dstSessionDir}/state.json`,
    JSON.stringify(patched, null, 2),
  );

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
            return (JSON.parse(landed.text) as Record<string, unknown>)[workDirKey];
          } catch {
            return null;
          }
        })();
  if (landedWorkDir !== input.cwd) {
    // The copy stays: `fsWrite` has no delete. Inert, not ignored — unlisted
    // without an index line, and overwritten by a later fork to the same target.
    throw new Error(
      `kimi fork of ${input.sessionId}: the clone landed in ${
        typeof landedWorkDir === "string" ? landedWorkDir : "an unreadable state"
      }, not ${input.cwd} — not activating it`,
    );
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
  return newId;
}

/** Copy every file under `srcDir` into the mirrored path under `dstDir`,
 * EXCEPT the top-level `state.json` (its patched version is written last —
 * it is the activation artifact). Depth-first via the read `fs` capability;
 * symlinks are skipped (kimi's store has none, and following one out of the
 * store would be refused by write containment anyway). */
async function copyTree(
  ctx: PluginContext,
  srcDir: string,
  dstDir: string,
  root = true,
): Promise<void> {
  const entries = await ctx.services.fs.readDir(srcDir);
  for (const entry of entries) {
    const dst = `${dstDir}/${entry.name}`;
    if (entry.kind === "dir") {
      await copyTree(ctx, entry.path, dst, false);
    } else if (entry.kind === "file") {
      // Only the SESSION-ROOT state.json is deferred (patched, written last).
      if (root && entry.name === "state.json") continue;
      await ctx.services.fsWrite.copyFile(entry.path, dst);
    }
  }
}

/** `wd_<slug-of-basename>_<sha256(absolute-cwd)[:12]>` — the store folder
 * kimi files a directory's sessions under.
 *
 * The shape this returns is upstream-validated (see the module docblock);
 * the derivation is ours, from probing, and no upstream source states it.
 *
 * The SLUG is what kimi's own encoder does to the basename and what a plain
 * lowercase missed: anything outside `[a-z0-9._-]` becomes a dash, the result
 * is cut to forty characters, and an empty one becomes "workspace". A folder
 * named with spaces, non-Latin letters, or simply a long name would otherwise
 * derive a key kimi never files anything under — a fork that lands in a
 * directory nobody looks in, and no error to say so. */
function slugOfBasename(cwd: string): string {
  const slug = cwd
    .slice(cwd.lastIndexOf("/") + 1)
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .slice(0, 40);
  return slug === "" ? "workspace" : slug;
}

export async function wdKey(cwd: string): Promise<string> {
  const base = slugOfBasename(cwd);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(cwd),
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `wd_${base}_${hex.slice(0, 12)}`;
}
