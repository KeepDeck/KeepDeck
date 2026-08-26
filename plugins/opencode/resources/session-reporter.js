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
 * Two jobs, both best-effort (a KeepDeck-less environment, or a deck that
 * went away, must never break the user's session):
 *  - Every ROOT `session.created` becomes a bridge-protocol-v2 `session.bound`
 *    envelope — the pane ⇄ session identity. A resumed session is also bound
 *    when its first completed message (or child-session event) reveals it.
 *  - Every COMPLETED assistant `message.updated` becomes a `usage.report`
 *    envelope. OpenCode reports tokens/cost PER MESSAGE, so the active root and
 *    all descendant histories are hydrated and their latest snapshots summed.
 *    Context-window limits are keyed by provider + model. OpenCode exposes no
 *    account rate-limit windows, so the report is pane usage only.
 *
 * Envelopes are posted to the deck's own surface, whose address arrives in
 * `KEEPDECK_BRIDGE` at spawn.
 */
import {
  createSubagentIndex,
  makeEnvelope,
  publish as publishEnvelope,
  readBridge,
} from "./keepdeck-bridge.js";

export default async (input = {}) => {
  const bridge = readBridge();
  if (!bridge) return {}; // not spawned by KeepDeck — stay inert
  const { dir } = bridge;

  const client = input?.client;

  /** State one fact about this pane.
   *
   * The handler is not kept waiting — it hands the envelope over and returns.
   * What waits is the next POST, so the deck reads these facts in the order
   * the bus stated them; see `publish` in keepdeck-bridge.js for why that
   * ordering is not free. */
  const publish = (type, payload) => {
    publishEnvelope(bridge, makeEnvelope(bridge, type, payload));
  };

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
    publish("session.bound", {
      sessionId: sessionID,
      source: continuing ? "new" : "startup",
    });

  /** `keep` is the ancestry the caller has already established for the
   * session it is binding through — the index is cleared here, and anything
   * learned on the way in would go with it. */
  const activateRoot = async (sessionID, publishBinding, keep = []) => {
    // Read before the assignment below: whether this pane already had a root
    // IS the difference between a startup and a `/new`.
    const continuing = activeRoot !== undefined;
    activeRoot = sessionID;
    messages.clear();
    subagents.clear();
    for (const [child, parent] of keep) subagents.note(child, parent);
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

  /**
   * One bus event, VERBATIM, on the `agent.status` protocol.
   *
   * The payload travels whole. This process answers one question about an
   * event — whose it is — and nothing about what it means: the session tree,
   * the process boundary and the window before the pane is bound exist only
   * here, and the deck cannot reconstruct them. Everything else is the
   * normalizer's, because it can change its mind about a payload it has and
   * never about one that was reduced on the way.
   *
   * Which is why the reduction that used to happen here was a defect and not
   * a saving. Forwarding `session.status` only when busy hid the retry state
   * behind it; flattening `error.name` to a string threw away the eight names
   * apart from which an abort cannot be told from a failure. Both decisions
   * were about MEANING, made a process away from where meaning is decided.
   */
  const forward = (event) =>
    publish("agent.status", {
      event: { type: event.type, properties: event.properties ?? {} },
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

  /**
   * Whose event this is — the only question answered on this side.
   *
   * An attribution mistake is silent and unrecoverable: a dropped event is
   * one the deck never hears about and cannot ask for. A translation mistake
   * is fixed in one file. So the doubt goes one way — overboard goes only
   * what certainly belongs to another conversation.
   */
  const belongsHere = (event) => {
    const props = event.properties ?? {};
    switch (event.type) {
      case "session.status":
      case "session.idle":
        return concernsPane(props.sessionID);
      case "session.error":
        // opencode declares sessionID OPTIONAL on this event, and the
        // publishers that omit it are process-wide — a plugin crash, a failed
        // skill. This process serves exactly one pane, so an error with no
        // session named can only be its own; only one attributed to some
        // OTHER session is filtered.
        return !props.sessionID || concernsPane(props.sessionID);
      case "permission.asked":
      case "permission.replied":
      case "question.asked":
      case "question.replied":
      case "question.rejected":
        // A dialog parks the TERMINAL, whichever session put it up: a
        // subagent's request holds the frame of the turn that spawned it, so
        // "waiting for a human" is true of the PANE either way. Measured. A
        // root filter here would manufacture a turn that never ends —
        // eternally working while the terminal stands still.
        return true;
      default:
        return false;
    }
  };

  const handle = async (event) => {
    if (belongsHere(event)) {
      forward(event);
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
        // The parent may itself be a subagent this process never watched
        // being created — a pane resumed mid-task sees a grandchild first.
        // Asked before `rootOf`, or the pane binds to the middle of a chain.
        if (!activeRoot) await subagents.classify(created.parentID);
        const rootSessionID = subagents.rootOf(created.parentID);
        if (!activeRoot) await activateRoot(rootSessionID, true, [
          ...subagents.chain(created.parentID),
        ]);
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
    // Asked for its side effect: the index learns the chain, so `rootOf`
    // below answers with the pane's conversation rather than a leaf.
    if (!activeRoot) await subagents.classify(info.sessionID);
    const owningRoot = subagents.rootOf(info.sessionID);
    // The WHOLE chain, captured before `activateRoot` clears the index — a
    // new root is a new generation. Putting back only the leaf's own link
    // left every intermediate subagent resolving to itself, failing the root
    // check below, and its spend never reaching the pane's total; hydration
    // repairs that only when the client answers `session.children`, and that
    // failure is swallowed.
    if (!activeRoot) {
      await activateRoot(owningRoot, true, [...subagents.chain(info.sessionID)]);
    }
    // Once a root is explicitly active, events for unrelated root sessions
    // in the same OpenCode server are not this pane's conversation.
    if (owningRoot !== activeRoot) return;
    // A FINISHED message is a fact about the turn, and it carries endings
    // that no event does: an interrupt caught between steps writes its name
    // here and publishes no `session.error` at all, and a structured-output
    // failure exists nowhere else. A streaming frame is not a fact — it is a
    // fragment of content, filtered here for the same reason the part deltas
    // never travel. What a finished message MEANS stays the normalizer's.
    forward(event);
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
    publish("usage.report", {
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
