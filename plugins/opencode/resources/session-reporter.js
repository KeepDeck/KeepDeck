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
 *    envelope — the pane ⇄ session identity. A resumed session is also bound
 *    when its first completed message (or child-session event) reveals it.
 *  - Every COMPLETED assistant `message.updated` becomes a `usage.report`
 *    envelope. OpenCode reports tokens/cost PER MESSAGE, so the active root and
 *    all descendant histories are hydrated and their latest snapshots summed.
 *    Context-window limits are keyed by provider + model. OpenCode exposes no
 *    account rate-limit windows, so the report is pane usage only.
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

  // Per-message latest snapshot for the ACTIVE ROOT session and all of its
  // descendants, summed into the session cumulative. A new root session owns a
  // new generation: `/new`/fork must never inherit the previous root's spend.
  const messages = new Map();
  // child session id → root session id. Descendant spend rolls up to the pane's
  // root, while only root turns define context occupancy and model identity.
  const childRoots = new Map();
  let activeRoot;
  // The latest ROOT assistant turn — defines occupancy/identity, not spend.
  let root;
  let sequence = 0;
  let hydration;
  const sum = (key) => {
    let total = 0;
    for (const m of messages.values()) total += m[key] ?? 0;
    return total;
  };

  const turnOf = (info) => {
    const t = info?.tokens ?? {};
    const cache = t.cache ?? {};
    return {
      input: t.input ?? 0,
      output: t.output ?? 0,
      reasoning: t.reasoning ?? 0,
      cacheRead: cache.read ?? 0,
      cacheWrite: cache.write ?? 0,
      cost: info?.cost ?? 0,
    };
  };

  const completedAssistant = (value) => {
    const info = value?.info ?? value;
    return info?.role === "assistant" && info?.time?.completed && info?.id
      ? info
      : undefined;
  };

  const remember = (info, rootSessionID) => {
    const turn = turnOf(info);
    messages.set(`${info.sessionID}\0${info.id}`, turn);
    if (info.sessionID === rootSessionID) {
      const completedAt = info.time?.completed ?? 0;
      if (!root || completedAt >= root.completedAt) {
        root = {
          sessionID: info.sessionID,
          providerID: info.providerID,
          modelID: info.modelID,
          completedAt,
          turn,
        };
      }
    }
  };

  const responseData = (response) => response?.data ?? response;

  /** Best-effort full-session hydration. It makes resume totals honest and
   * restores descendant spend without reading opencode's private SQLite. */
  const hydrateSession = async (sessionID, rootSessionID, seen) => {
    if (!sessionID || seen.has(sessionID)) return;
    seen.add(sessionID);
    if (client?.session?.messages) {
      try {
        const result = await client.session.messages({ sessionID });
        const rows = responseData(result);
        if (Array.isArray(rows)) {
          for (const row of rows) {
            const info = completedAssistant(row);
            if (info) remember(info, rootSessionID);
          }
        }
      } catch {
        // Live events still produce a valid since-start snapshot.
      }
    }
    if (!client?.session?.children) return;
    try {
      const result = await client.session.children({ sessionID });
      const children = responseData(result);
      if (!Array.isArray(children)) return;
      for (const child of children) {
        if (!child?.id) continue;
        childRoots.set(child.id, rootSessionID);
        await hydrateSession(child.id, rootSessionID, seen);
      }
    } catch {
      // Descendants created after startup are still tracked by session.created.
    }
  };

  const bind = (sessionID) =>
    publish({
      v: 1,
      type: "session.bound",
      paneId: pane,
      token,
      payload: { sessionId: sessionID, agent: "opencode" },
    });

  const activateRoot = async (sessionID, publishBinding) => {
    activeRoot = sessionID;
    messages.clear();
    childRoots.clear();
    root = undefined;
    sequence = 0;
    if (publishBinding) bind(sessionID);
    hydration = hydrateSession(sessionID, sessionID, new Set());
    await hydration;
  };

  // (providerID, modelID) → context-window size, resolved lazily from the
  // provider catalog and cached ONCE ON SUCCESS. OpenCode model ids are not
  // globally unique; flattening by modelID alone selects another provider's
  // context limit. An in-flight promise makes the fetch single-flight.
  let windowByModel;
  let windowLoad;
  const modelKey = (providerID, modelID) => `${providerID}\0${modelID}`;
  const contextWindow = async (providerID, modelID) => {
    if (!providerID || !modelID || !client?.config?.providers) return undefined;
    if (!windowByModel) {
      if (!windowLoad) {
        windowLoad = (async () => {
          const res = await client.config.providers();
          const providers = res?.data?.providers ?? res?.providers ?? [];
          const resolved = new Map();
          for (const provider of providers) {
            if (!provider?.id) continue;
            for (const [id, model] of Object.entries(provider.models ?? {})) {
              const ctx = model?.limit?.context;
              if (typeof ctx === "number") {
                resolved.set(modelKey(provider.id, id), ctx);
              }
            }
          }
          windowByModel = resolved;
        })();
      }
      try {
        await windowLoad;
      } catch {
        windowLoad = undefined;
        return undefined; // leave unresolved → retry on the next message
      }
    }
    return windowByModel.get(modelKey(providerID, modelID));
  };

  const handle = async (event) => {
    if (event?.type === "session.created") {
      // Root sessions only. opencode's task/subagent tool creates CHILD
      // sessions in this same process, each firing `session.created` with
      // `parentID` set — binding to one would rebind the pane to a transient
      // leaf. Remember the child id so only its spend, never its occupancy,
      // rolls up to the pane root.
      const created = event.properties?.info;
      if (created?.parentID) {
        const rootSessionID =
          childRoots.get(created.parentID) ?? created.parentID;
        if (!activeRoot) await activateRoot(rootSessionID, true);
        if (rootSessionID !== activeRoot) return;
        if (created.id) childRoots.set(created.id, rootSessionID);
        return;
      }
      const sessionId = created?.id;
      if (!sessionId) return;
      await activateRoot(sessionId, true);
      return;
    }

    if (event?.type !== "message.updated") return;
    const info = completedAssistant(event.properties);
    // Assistant messages only, once the turn is DONE (message.updated fires
    // repeatedly as a message streams; the completed frame carries the final
    // counts).
    if (!info) return;
    const owningRoot = childRoots.get(info.sessionID) ?? info.sessionID;
    if (!activeRoot) await activateRoot(owningRoot, true);
    // Once a root is explicitly active, events for unrelated root sessions
    // in the same OpenCode server are not this pane's conversation.
    if (owningRoot !== activeRoot) return;
    if (hydration) await hydration;
    // Every assistant turn — ROOT or subagent — is real session spend and
    // sums into the cumulative. But a subagent's context is ITS own, not the
    // pane's conversation, so only a ROOT turn sets occupancy + identity.
    remember(info, activeRoot);
    if (!root) return; // no root turn seen yet — accumulate, publish later

    // Immutable report basis before the async catalog lookup. The queue below
    // serializes callbacks too, but capturing keeps this function locally sane.
    const currentRoot = root;
    const occ = currentRoot.turn;
    const contextTokens =
      occ.input + occ.output + occ.reasoning + occ.cacheRead + occ.cacheWrite;
    const windowTokens = await contextWindow(
      currentRoot.providerID,
      currentRoot.modelID,
    );
    publish({
      v: 1,
      type: "usage.report",
      paneId: pane,
      token,
      payload: {
        agent: "opencode",
        sessionId: currentRoot.sessionID,
        providerId: currentRoot.providerID,
        model: currentRoot.modelID,
        sequence: ++sequence,
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
          input: occ.input,
          output: occ.output,
          reasoning: occ.reasoning,
          cacheRead: occ.cacheRead,
          cacheWrite: occ.cacheWrite,
        },
        costUsd: sum("cost"),
      },
    });
  };

  // OpenCode deliberately does not await plugin event promises. Reduce every
  // event through our own queue so hydration/catalog IO cannot interleave two
  // mutations or let an older snapshot publish after a newer one.
  let eventQueue = Promise.resolve();
  return {
    event: ({ event }) => {
      eventQueue = eventQueue.then(() => handle(event)).catch(() => {});
      return eventQueue;
    },
  };
};
