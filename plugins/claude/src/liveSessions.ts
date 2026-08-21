import type {
  AgentLiveSession,
  AgentLiveSessions,
  PluginContext,
  PluginSessionEvent,
} from "@keepdeck/plugin-api";

/**
 * Which claude sessions are alive RIGHT NOW — held by an interactive run or
 * a background agent of the daemon. The CLI's own machine interface:
 * `claude agents --json` (documented for scripting, no TTY needed), one
 * row per live process with the session id a resume would be refused over.
 *
 * A SNAPSHOT, not a watch: the host asks before acting on a resume refusal
 * and when a picker opens — a question about this instant, answered about
 * this instant. Runs as a short-lived PTY child via the plugin session
 * service (the established pattern for a plugin running its own CLI
 * out-of-band), collects stdout, and exits.
 */

interface RawLiveRow {
  sessionId?: unknown;
  kind?: unknown;
  name?: unknown;
  state?: unknown;
}

/** Parse the CLI's rows down to the contract's shape; `null` = the output
 * was not the documented JSON array (a version change, a stray banner). */
export function parseLiveSessions(stdout: string): AgentLiveSession[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const rows: AgentLiveSession[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) return null;
    const row = item as RawLiveRow;
    // A row without a session id names no conversation we could refuse to
    // resume — skipped, not fatal, exactly like a store entry without a
    // transcript. But a row whose id/kind are off-TYPE breaks the whole
    // answer: silently inventing a partial registry is the failure mode
    // this capability exists to prevent.
    if (typeof row.sessionId !== "string") return null;
    if (typeof row.kind !== "string") return null;
    rows.push({
      sessionId: row.sessionId,
      kind: row.kind,
      ...(typeof row.name === "string" && row.name !== "" ? { name: row.name } : {}),
      ...(typeof row.state === "string" && row.state !== "" ? { state: row.state } : {}),
    });
  }
  return rows;
}

/** Cap on collected stdout — the registry is a few hundred bytes per row;
 * anything approaching this size is a runaway process, not a listing. */
const MAX_OUTPUT = 4 * 1024 * 1024;

export function claudeLiveSessions(ctx: PluginContext): AgentLiveSessions {
  return {
    async list(): Promise<AgentLiveSession[]> {
      // A THROWING list() is a legitimate answer the caller reads as
      // UNKNOWN (never as "nothing is live"): a broken CLI, a dead daemon.
      // The plugin's job is to make the failure a precise error, not to
      // soften it into an empty list.
      const decoder = new TextDecoder();
      let stdout = "";
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const done = (err: unknown) => {
          if (settled) return;
          settled = true;
          err ? reject(err) : resolve();
        };
        ctx.services.sessions.spawn(
          {
            command: "claude",
            args: ["agents", "--json"],
            cols: 80,
            rows: 24,
          },
          (event: PluginSessionEvent) => {
            if (event.type === "output") {
              stdout += decoder.decode(event.bytes, { stream: true });
              if (stdout.length > MAX_OUTPUT) {
                done(new Error("claude agents --json: output exceeded the cap"));
              }
              return;
            }
            if (event.code === 0) return done(null);
            done(
              new Error(
                `claude agents --json exited with ${event.code ?? "no code"}`,
              ),
            );
          },
        ).then(
          (handle) => {
            void handle.close();
          },
          (error) => done(error),
        );
      });
      const rows = parseLiveSessions(stdout);
      if (rows === null) {
        throw new Error(
          "claude agents --json: output was not the documented JSON array",
        );
      }
      return rows;
    },
  };
}
