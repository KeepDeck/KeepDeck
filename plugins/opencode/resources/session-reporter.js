/**
 * KeepDeck session reporter — an opencode plugin.
 *
 * Injected PER SPAWN via the `OPENCODE_CONFIG_CONTENT` env var (which MERGES
 * into the user's config; nothing is installed or modified on their side) and
 * referenced by absolute path inside KeepDeck's resources. It runs inside the
 * pane's own opencode process, so `process.env` carries the single
 * `KEEPDECK_BRIDGE` var KeepDeck injected at spawn ({v, dir, pane, token}) —
 * attribution is exact even when several agents spawn in parallel, and `/new`
 * typed inside the TUI is caught too.
 *
 * Two jobs, both best-effort (a KeepDeck-less environment, or a full disk,
 * must never break the user's session):
 *  - Every ROOT `session.created` becomes a bridge-protocol-v1 `session.bound`
 *    envelope — the pane ⇄ session identity.
 *  - Every COMPLETED assistant `message.updated` becomes a `usage.report`
 *    envelope. OpenCode reports tokens/cost PER MESSAGE, so the running session
 *    cumulative is kept here (latest snapshot per message id, summed); the
 *    context-window size is resolved once from the SDK client's provider
 *    catalog and cached. OpenCode exposes no account rate-limit windows, so the
 *    report is pane usage only.
 *
 * Envelopes are uniquely named (randomUUID, so parallel events never collide),
 * written as `.tmp` and renamed so the watcher never sees a torn file.
 */
import { randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export default async (input = {}) => {
  let bridge;
  try {
    bridge = JSON.parse(process.env.KEEPDECK_BRIDGE ?? "");
  } catch {
    return {}; // not spawned by KeepDeck — stay inert
  }
  const { dir, pane, token } = bridge ?? {};
  if (!dir || !pane || !token) return {};

  const client = input?.client;

  /** Atomically drop one bridge envelope into the inbox. Best-effort. */
  const publish = (envelope) => {
    try {
      const base = join(dir, `${envelope.type}-${randomUUID()}`);
      writeFileSync(`${base}.tmp`, JSON.stringify(envelope));
      renameSync(`${base}.tmp`, `${base}.json`);
    } catch {
      // best-effort by design
    }
  };

  // Per-message latest snapshot, summed into the session cumulative. Keyed by
  // message id so a streamed message's repeated updates replace, not stack.
  const messages = new Map();
  const sum = (key) => {
    let total = 0;
    for (const m of messages.values()) total += m[key] ?? 0;
    return total;
  };

  // modelID → context-window size, resolved lazily from the provider catalog
  // and cached. Degrades to undefined (tokens shown without a %) on any error.
  let windowByModel;
  const contextWindow = async (modelID) => {
    if (!modelID || !client?.config?.providers) return undefined;
    if (!windowByModel) {
      windowByModel = new Map();
      try {
        const res = await client.config.providers();
        const providers = res?.data?.providers ?? res?.providers ?? [];
        for (const provider of providers) {
          for (const [id, model] of Object.entries(provider?.models ?? {})) {
            const ctx = model?.limit?.context;
            if (typeof ctx === "number") windowByModel.set(id, ctx);
          }
        }
      } catch {
        // degrade: no window size available
      }
    }
    return windowByModel.get(modelID);
  };

  return {
    event: async ({ event }) => {
      if (event?.type === "session.created") {
        // Root sessions only. opencode's task/subagent tool creates CHILD
        // sessions in this same process, each firing `session.created` with
        // `parentID` set — binding to one would rebind the pane to a transient
        // leaf, and the next restore would resume that leaf.
        if (event.properties?.info?.parentID) return;
        const sessionId = event.properties?.info?.id;
        if (!sessionId) return;
        publish({
          v: 1,
          type: "session.bound",
          paneId: pane,
          token,
          payload: { sessionId, agent: "opencode" },
        });
        return;
      }

      if (event?.type !== "message.updated") return;
      const info = event.properties?.info ?? event.properties;
      // Assistant messages only, and only once the turn is DONE — message.updated
      // fires repeatedly as a message streams; the completed frame carries the
      // final counts, so gating on it emits ~once per turn.
      if (!info || info.role !== "assistant" || !info.time?.completed || !info.id) {
        return;
      }
      const t = info.tokens ?? {};
      const cache = t.cache ?? {};
      messages.set(info.id, {
        input: t.input ?? 0,
        output: t.output ?? 0,
        reasoning: t.reasoning ?? 0,
        cacheRead: cache.read ?? 0,
        cacheWrite: cache.write ?? 0,
        cost: info.cost ?? 0,
      });
      const last = messages.get(info.id);
      const contextTokens =
        last.input + last.output + last.reasoning + last.cacheRead + last.cacheWrite;
      const windowTokens = await contextWindow(info.modelID);
      publish({
        v: 1,
        type: "usage.report",
        paneId: pane,
        token,
        payload: {
          agent: "opencode",
          sessionId: info.sessionID,
          model: info.modelID,
          ...(windowTokens !== undefined ? { windowTokens } : {}),
          contextTokens,
          totals: {
            input: sum("input"),
            output: sum("output"),
            reasoning: sum("reasoning"),
            cacheRead: sum("cacheRead"),
            cacheWrite: sum("cacheWrite"),
          },
          lastTurn: {
            input: last.input,
            output: last.output,
            reasoning: last.reasoning,
            cacheRead: last.cacheRead,
            cacheWrite: last.cacheWrite,
          },
          costUsd: sum("cost"),
        },
      });
    },
  };
};
