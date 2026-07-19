import type { ForkPlanInput, PluginContext } from "@keepdeck/plugin-api";

/**
 * Kimi's cross-directory fork ([F8], probe-verified on kimi 0.27):
 *
 * A session lives at `<home>/sessions/wd_<key>/session_<id>/` as exactly
 * three files — `state.json`, `agents/main/wire.jsonl`, `logs/kimi-code.log`
 * — with the id and every path embedded ONLY in `state.json`. `kimi
 * --session <id>` resolves the id via the global `session_index.jsonl`,
 * then gates on `state.json.workDir` matching the invocation cwd.
 *
 * A non-destructive fork is therefore a three-file clone under a fresh id:
 * copy the session dir into the TARGET cwd's `wd_` folder, patch `workDir`
 * (the gate) and `agents.main.homedir` (the one embedded absolute path),
 * and append the new id to the index. The original stays resumable where
 * it was. The `wd_` key is `wd_<lowercased-basename>_<sha256(cwd)[:12]>`
 * — formula verified against real store entries.
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
  // …/sessions/wd_<key>/session_<id>/agents/main/wire.jsonl — walking the
  // recorded path (never guessing the home) keeps a KIMI_CODE_HOME override
  // working and makes a layout change fail LOUDLY here.
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
  if (typeof state.workDir !== "string" || typeof agents?.main?.homedir !== "string") {
    throw new Error(
      `kimi fork of ${input.sessionId}: state.json misses workDir/agents.main.homedir — layout changed?`,
    );
  }

  const newId = `session_${crypto.randomUUID()}`;
  const dstSessionDir = `${sessionsRoot}/${await wdKey(input.cwd)}/${newId}`;

  // Clone: patched state first (the gate), then the conversation wire; the
  // diagnostic log is best-effort — kimi resumes fine without it.
  const patched = {
    ...state,
    workDir: input.cwd,
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
  await ctx.services.fsWrite.copyFile(
    wire,
    `${dstSessionDir}/agents/main/wire.jsonl`,
  );
  try {
    await ctx.services.fsWrite.copyFile(
      `${srcSessionDir}/logs/kimi-code.log`,
      `${dstSessionDir}/logs/kimi-code.log`,
    );
  } catch {
    // Optional diagnostics; a session that never logged has no file.
  }

  // The index is how `--session <id>` finds the clone at all.
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

/** `wd_<lowercased-basename>_<sha256(absolute-cwd)[:12]>` — the store folder
 * kimi files a directory's sessions under (formula probe-verified). */
export async function wdKey(cwd: string): Promise<string> {
  const base = cwd.slice(cwd.lastIndexOf("/") + 1).toLowerCase();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(cwd),
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `wd_${base}_${hex.slice(0, 12)}`;
}
