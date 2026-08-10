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
import {
  REPORTER,
  createSubagentIndex,
  publish as publishTo,
  readBridge,
} from "./keepdeck-bridge.js";

export default async (input = {}) => {
  const bridge = readBridge();
  if (!bridge) return {}; // not spawned by KeepDeck — stay inert
  const { dir, pane, token } = bridge;

  const client = input?.client;

  /** Atomically drop one bridge envelope into this pane's inbox. */
  const publish = (envelope) => publishTo(dir, envelope);

  // Per-message latest snapshot for the ACTIVE ROOT session and all of its
  // descendants, summed into the session cumulative. A new root session owns a
  // new generation: `/new`/fork must never inherit the previous root's spend.
  const messages = new Map();
  // Which sessions here are subagents' and which root their work rolls up to.
  // Descendant spend rolls up to the pane's root, while only root turns define
  // context occupancy and model identity. Shared with the mail courier beside
  // this file: two answers to "is this the pane's conversation" means the deck
  // watching one session's turns while mail lands in another.
  const subagents = createSubagentIndex(client);
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

  /**
   * How this client wants a session id: as a PATH parameter.
   *
   * Measured on opencode 1.18.15 by loading a probe plugin into a live
   * server: `session.messages({sessionID})` answers `{error: UnknownError}`
   * while `session.messages({path:{id}})` answers with the rows. The flat
   * form is what opencode's OWN code uses — but on its internal SDK wrapper,
   * not on the generated client a plugin is handed, and the two do not agree.
   *
   * The client RESOLVES with `{error}` instead of throwing, so the wrong
   * shape here cost nothing visible: hydration returned no rows, the catch
   * below never fired, and the totals quietly became since-start-only on
   * every resume — with descendant spend missing entirely.
   */
  const forSession = (sessionID) => ({ path: { id: sessionID } });

  /** Best-effort full-session hydration. It makes resume totals honest and
   * restores descendant spend without reading opencode's private SQLite. */
  const hydrateSession = async (sessionID, rootSessionID, seen) => {
    if (!sessionID || seen.has(sessionID)) return;
    seen.add(sessionID);
    if (client?.session?.messages) {
      try {
        const result = await client.session.messages(forSession(sessionID));
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
      const result = await client.session.children(forSession(sessionID));
      const children = responseData(result);
      if (!Array.isArray(children)) return;
      for (const child of children) {
        if (!child?.id) continue;
        subagents.note(child.id, rootSessionID);
        await hydrateSession(child.id, rootSessionID, seen);
      }
    } catch {
      // Descendants created after startup are still tracked by session.created.
    }
  };

  // A later root is the pane's conversation continuing under a new id
  // (`/new`), not a second session appearing out of nowhere — so it is
  // reported as what it is. Derived from `activeRoot` rather than a flag of
  // its own: a second copy of "has this pane bound yet" is a second place for
  // that answer to be wrong, and this one would keep saying "continuing"
  // after a publish that silently failed.
  const bind = (sessionID, continuing) =>
    publish({
      v: 1,
      type: "session.bound",
      paneId: pane,
      token,
      payload: {
        sessionId: sessionID,
        agent: "opencode",
        source: continuing ? "new" : "startup",
        reporter: REPORTER,
      },
    });

  const activateRoot = async (sessionID, publishBinding) => {
    // Read before the assignment below: whether this pane already had a root
    // IS the difference between a startup and a `/new`.
    const continuing = activeRoot !== undefined;
    activeRoot = sessionID;
    messages.clear();
    subagents.clear();
    root = undefined;
    sequence = 0;
    if (publishBinding) bind(sessionID, continuing);
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

  /** One turn-lifecycle edge for the pane — `agent.status` protocol. Only
   * the fields the status normalizer reads travel; the raw bus event stays
   * in this process. */
  const reportStatus = (type, extra = {}) =>
    publish({
      v: 1,
      type: "agent.status",
      paneId: pane,
      token,
      payload: { agent: "opencode", reporter: REPORTER, event: { type, ...extra } },
    });

  /** Whether a session-scoped event describes the PANE's conversation: the
   * active root itself — never a subagent child (a child going busy/idle is
   * not the pane's turn boundary) — and any non-child session before a root
   * is known, because a status edge beating `session.created` should still
   * land rather than strand the pane. */
  const concernsPane = (sessionID) => {
    if (!sessionID || subagents.rootOf(sessionID) !== sessionID) return false;
    return !activeRoot || sessionID === activeRoot;
  };

  const handle = async (event) => {
    if (event?.type === "session.status") {
      const props = event.properties ?? {};
      const status =
        typeof props.status === "object" ? props.status?.type : props.status;
      // Only `busy` marks a turn starting; the idle STATUS is redundant with
      // the explicit session.idle event below.
      if (status === "busy" && concernsPane(props.sessionID)) {
        reportStatus("session.status");
      }
      return;
    }
    if (event?.type === "session.idle") {
      // Fires on completion AND on a user interrupt — either way the turn
      // is over, which is why opencode needs no transcript-marker recovery.
      if (concernsPane(event.properties?.sessionID)) {
        reportStatus("session.idle");
      }
      return;
    }
    if (event?.type === "session.error") {
      const props = event.properties ?? {};
      // opencode declares sessionID OPTIONAL on this event. A session-less
      // error still concerns the pane — this process serves exactly one —
      // so only an error attributed to some OTHER session is filtered.
      if (!props.sessionID || concernsPane(props.sessionID)) {
        const name = props.error?.name;
        reportStatus(
          "session.error",
          typeof name === "string" && name !== "" ? { error: name } : {},
        );
      }
      return;
    }
    // Permission prompts park the whole TUI regardless of which session
    // asked — no root filter.
    if (event?.type === "permission.asked") {
      reportStatus("permission.asked");
      return;
    }
    if (event?.type === "permission.replied") {
      // Even a REJECT keeps the turn in flight (the model receives the
      // denial, produces text, then idles) — every reply reads as resumed.
      reportStatus("permission.replied");
      return;
    }

    if (event?.type === "session.created") {
      // Root sessions only. opencode's task/subagent tool creates CHILD
      // sessions in this same process, each firing `session.created` with
      // `parentID` set — binding to one would rebind the pane to a transient
      // leaf. Remember the child id so only its spend, never its occupancy,
      // rolls up to the pane root.
      const created = event.properties?.info;
      if (created?.parentID) {
        const rootSessionID = subagents.rootOf(created.parentID);
        if (!activeRoot) await activateRoot(rootSessionID, true);
        if (rootSessionID !== activeRoot) return;
        if (created.id) subagents.note(created.id, rootSessionID);
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
    // Binding is how a RESUMED pane is discovered: it fires no root
    // `session.created`, so its first completed message is the only thing
    // that names its conversation. Which is exactly when a subagent's message
    // can be first — a pane resumed mid-task — and this used to bind the pane
    // to that leaf, reporting a subagent's turns as the pane's until it
    // ended. The index ASKS the server about a session it never watched being
    // created, so the pane binds to the parent instead of the child.
    // Asked for its side effect: the index learns the parent, so `rootOf`
    // below answers with the pane's conversation rather than the leaf.
    if (!activeRoot) await subagents.isChild(info.sessionID);
    const owningRoot = subagents.rootOf(info.sessionID);
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
        reporter: REPORTER,
        sessionId: currentRoot.sessionID,
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
