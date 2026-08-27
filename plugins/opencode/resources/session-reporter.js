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
  makeEnvelope,
  publish as publishEnvelope,
  readBridge,
} from "./keepdeck-bridge.js";
import { paneSession } from "./pane-session.js";

export default async (input = {}) => {
  const bridge = readBridge();
  if (!bridge) return {}; // not spawned by KeepDeck — stay inert
  const { dir } = bridge;

  /**
   * Whether this pane was launched with approval prompts skipped — the deck's
   * own choice at spawn, stated here because it cannot be discovered from
   * inside the process.
   *
   * Read at startup, not per event: the mode is an argument the CLI was
   * started with and cannot change under a running one.
   */
  const SKIPS_APPROVALS =
    process.env.KEEPDECK_OPENCODE_SKIPS_APPROVALS === "1";

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
  // Which session is the pane's conversation, and which of the others are
  // subagents' — ONE object, shared with the mail courier beside this file.
  // Two answers to that question means the deck watching one session's turns
  // while mail lands in another.
  const pane = paneSession(client);
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
        pane.note(child.id, rootSessionID);
        await hydrateSession(child.id, rootSessionID, seen);
      }
    } catch {
      // Descendants created after startup are still tracked by session.created.
    }
  };

  // A later root is the pane's conversation continuing under a new id
  // (`/new`), not a second session appearing out of nowhere — so it is
  // reported as what it is. Derived from whether the pane was already bound
  // rather than a flag of its own: a second copy of "has this pane bound yet"
  // is a second place for that answer to be wrong, and this one would keep
  // saying "continuing" after a publish that silently failed.
  const bind = (sessionID, continuing) =>
    publish("session.bound", {
      sessionId: sessionID,
      source: continuing ? "new" : "startup",
    });

  /**
   * Take a session as the pane's conversation, then set up for it.
   *
   * `keep` is the ancestry already established for the session being bound
   * THROUGH — a descendant whose chain was learned on the way in. Its presence
   * is the difference between the two things the first half does: binding to a
   * conversation already in progress keeps what is known about it, while a
   * root the pane just watched appear owns nothing from the last one.
   */
  const activateRoot = async (sessionID, publishBinding, keep) => {
    if (keep) pane.bindFromChain(sessionID, keep);
    else pane.newGeneration(sessionID);
    await setUpForConversation(publishBinding);
  };

  /**
   * Everything this reporter owes a conversation it has not served yet.
   *
   * KEYED ON WHICH CONVERSATION, NOT ON WHO MOVED IT THERE. Both plugins watch
   * the same `session.created` on their own queues, and the courier's is free
   * to run while this one waits on hydration or on the provider catalog — so
   * the courier can be the one that sets the new root. Gating this on having
   * performed the move lost all of it in that window: no binding published, so
   * the deck no longer knows which session the pane is; no accumulators
   * cleared, so a new conversation inherited the last one's spend; no
   * hydration. None of it visible from either side.
   *
   * A session id is enough to key on, and no counter is needed: ids are unique
   * and a pane never returns to a conversation it has left, so `pane.root`
   * only ever moves forward. The same monotonicity that makes a generation
   * number unnecessary is what makes this comparison sound.
   *
   * `continuing` comes from THIS reporter's own history rather than from the
   * pane being bound, for the same reason — the courier may have bound it
   * already, and then a first conversation would report itself as a second.
   */
  let servedRoot;
  const setUpForConversation = async (publishBinding) => {
    if (pane.root === undefined || pane.root === servedRoot) return;
    const continuing = servedRoot !== undefined;
    servedRoot = pane.root;
    messages.clear();
    root = undefined;
    sequence = 0;
    if (publishBinding) bind(servedRoot, continuing);
    hydration = hydrateSession(servedRoot, servedRoot, new Set());
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

  /**
   * Whose event this is — the only question answered on this side.
   *
   * An attribution mistake is silent and unrecoverable: a dropped event is
   * one the deck never hears about and cannot ask for. A translation mistake
   * is fixed in one file. So the doubt goes one way — overboard goes only
   * what certainly belongs to another conversation.
   */
  /**
   * Whether this pane's turn has already been reported as running.
   *
   * opencode says `busy` once per MODEL CALL, not once per turn: twice on
   * submit and twice more after every tool result — ten times on a measured
   * turn that ran three commands. Each one reached the deck as a turn
   * beginning, and a beginning restarts the phase clock, so an 81-second turn
   * showed "Working · 3s".
   *
   * The clock is right to restart on a new turn — a CLI can begin one of its
   * own accord, and every other agent means exactly that by the edge. What was
   * wrong is saying it ten times.
   *
   * ONLY AN IDLE CLEARS IT, and that is the whole rule. Clearing on errors too
   * looked safer and was the same bug in miniature: some errors do not end the
   * turn at all — an overflowed context publishes one and then compacts, and a
   * crashing plugin publishes one that belongs to no turn — so the next model
   * call passed as news and the phase clock restarted on a turn that had never
   * stopped. And an ending without an idle does not exist: every one of them
   * goes through the same pair, checked against opencode's own code. The only
   * exception is the process dying, where this flag has nobody left to read it.
   *
   * That rule is also what keeps this side out of the business of meaning.
   * Knowing WHICH errors end a turn is the normalizer's; knowing that a fact
   * has already been stated is this one's.
   */
  let turnReported = false;

  const belongsHere = (event) => {
    const props = event.properties ?? {};
    switch (event.type) {
      case "session.status":
      case "session.idle":
        return pane.concernsPane(props.sessionID);
      case "session.error":
        // opencode declares sessionID OPTIONAL on this event, and the
        // publishers that omit it are process-wide — a plugin crash, a failed
        // skill. This process serves exactly one pane, so an error with no
        // session named can only be its own; only one attributed to some
        // OTHER session is filtered.
        return !props.sessionID || pane.concernsPane(props.sessionID);
      case "permission.asked":
      case "permission.replied":
        // An approval nobody will be asked for is not a wait. With approvals
        // skipped, opencode answers its own prompt in milliseconds and its
        // reply is indistinguishable from a person's — so the deck announced
        // "needs approval" for a dialog that never appeared. The pane's mode
        // is the only thing that tells the two apart, and it cannot be read
        // from inside the process, so the deck says it at spawn.
        //
        // Not a reading of the event: what a prompt MEANS is decided at the
        // other end. This is the same kind of answer as the list of types
        // that travel at all — in this mode that class of event does not
        // exist for this pane.
        return !SKIPS_APPROVALS;
      case "question.asked":
      case "question.replied":
      case "question.rejected":
        // A dialog parks the TERMINAL, whichever session put it up: a
        // subagent's request holds the frame of the turn that spawned it, so
        // "waiting for a human" is true of the PANE either way. Measured. A
        // root filter here would manufacture a turn that never ends —
        // eternally working while the terminal stands still.
        //
        // Untouched by the mode above: a question has no default answer, so
        // nothing can auto-pick one. Measured with approvals skipped — the
        // dialog stood open and waited.
        return true;
      default:
        return false;
    }
  };

  /**
   * Whether opencode is saying THE TURN IS RUNNING for a turn already reported
   * as running — and, when it is not, recording that it has now been said.
   *
   * Named for the answer and NOT written as a question, because it keeps one:
   * called twice on the same event it answers differently, and the second
   * answer is the true one. A pure-looking name over a recording call is worse
   * than a plain lie — a reader trusts it and calls it twice.
   */
  const sayingTheTurnRunsAgain = (event) => {
    if (event.type !== "session.status") return false;
    const status = event.properties?.status;
    const kind = typeof status === "object" ? status?.type : status;
    if (kind !== "busy") return false;
    if (turnReported) return true;
    turnReported = true;
    return false;
  };

  const handle = async (event) => {
    if (belongsHere(event)) {
      // An idle, and nothing else — see `turnReported` for why the errors that
      // looked like endings had to come out of this condition.
      if (event.type === "session.idle") {
        turnReported = false;
      }
      if (!sayingTheTurnRunsAgain(event)) forward(event);
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
        if (!pane.bound) await pane.classify(created.parentID);
        const rootSessionID = pane.rootOf(created.parentID);
        if (!pane.bound) {
          await activateRoot(rootSessionID, true, pane.chain(created.parentID));
        }
        if (rootSessionID !== pane.root) return;
        if (created.id) pane.note(created.id, rootSessionID);
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
    if (!pane.bound) await pane.classify(info.sessionID);
    const owningRoot = pane.rootOf(info.sessionID);
    // The WHOLE chain, captured before binding — putting back only the leaf's
    // own link left every intermediate subagent resolving to itself, failing
    // the root check below, and its spend never reaching the pane's total;
    // hydration repairs that only when the client answers `session.children`,
    // and that failure is swallowed.
    if (!pane.bound) {
      await activateRoot(owningRoot, true, pane.chain(info.sessionID));
    }
    // And if the courier bound the pane, or moved it, while this side was
    // away — a no-op when the line above already did the work.
    await setUpForConversation(true);
    // Once a root is explicitly active, events for unrelated root sessions
    // in the same OpenCode server are not this pane's conversation.
    if (owningRoot !== pane.root) return;
    // A FINISHED message of the pane's OWN turn is a fact about that turn, and
    // it carries an ending no event does: an interrupt caught between steps
    // writes its name here and publishes no `session.error` at all. A
    // streaming frame is not a fact — it is a fragment of content, filtered
    // here for the same reason the part deltas never travel. What a finished
    // message MEANS stays the normalizer's.
    //
    // A SUBAGENT'S message is not the pane's turn ending, and this lane exists
    // only for that reading — spend travels the usage report below, which
    // takes descendants on purpose. Forwarding a child's would let a subagent
    // cut short on its own account read as the pane being interrupted.
    if (info.sessionID === pane.root) forward(event);
    if (hydration) await hydration;
    // Every assistant turn — ROOT or subagent — is real session spend and
    // sums into the cumulative. But a subagent's context is ITS own, not the
    // pane's conversation, so only a ROOT turn sets occupancy + identity.
    remember(info, pane.root);
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
