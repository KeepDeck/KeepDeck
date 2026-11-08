// @ts-check
/**
 * KeepDeck session reporter — one of the two components of KeepDeck's
 * opencode plugin (index.js beside this file loads both).
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
 *  - A `usage.report` envelope carries the pane's context (from the latest
 *    COMPLETED root assistant message, its window keyed by provider + model)
 *    and the conversation's finished STEPS — each `step-finish` part one
 *    model call, the root's and every descendant's; a bound conversation's
 *    history is hydrated so a resumed pane reports what it has not yet.
 *    OpenCode exposes no account rate-limit windows, so the report is pane
 *    usage only.
 *
 * Envelopes are posted to the deck's own surface, whose address arrives in
 * `KEEPDECK_BRIDGE` at spawn.
 */
import {
  makeEnvelope,
  publish as publishEnvelope,
  readBridge,
} from "./keepdeck-bridge.js";
import { parentLookupV1 } from "./opencode-v1.js";
import {
  boundReport,
  createWindowCache,
  skipsApprovals,
  STEPS_PER_REPORT,
  tokenCounts,
  usageReport,
} from "./pane-report.js";
import { follower } from "./follower.js";
import { createLeaving } from "./leaving.js";
import { paneSession } from "./pane-session.js";

/** @typedef {import("./pane-report.js").TokenCounts} TokenCounts */
/** @typedef {{ id?: string, role?: string, sessionID?: string, parentID?: string, providerID?: string, modelID?: string, time?: { created?: number, completed?: number }, cost?: number, tokens?: import("./pane-report.js").OpenCodeTokens, info?: MessageInfo }} MessageInfo */
/** @typedef {MessageInfo & { id: string, sessionID: string }} CompletedInfo */
/** @typedef {{ type: "step-finish", id: string, messageID: string, sessionID: string, tokens?: import("./pane-report.js").OpenCodeTokens }} StepPart */
/** @typedef {{ type: string, properties?: Record<string, unknown> & { sessionID?: string, status?: string | (Record<string, unknown> & { type?: string }), info?: MessageInfo } }} ReporterEvent */
/** @typedef {{ id?: string, models?: Record<string, { limit?: { context?: number } }> }} Provider */
/** @typedef {{ session?: { get?: (query: { path: { id: string } }) => Promise<{ error?: unknown, data?: { id?: string, parentID?: string } }>, messages?: (query: { path: { id: string } }) => Promise<unknown>, children?: (query: { path: { id: string } }) => Promise<unknown>, abort?: (query: { path: { id: string } }) => Promise<unknown> }, config?: { providers?: () => Promise<{ data?: { providers?: Provider[] }, providers?: Provider[] }> } }} ReporterClient */

/** @param {unknown} [input] */
export async function startReporter(input = {}) {
  const bridge = readBridge();
  if (!bridge) return {}; // not spawned by KeepDeck — stay inert

  /** Whether this pane skips approval prompts (pane-report.js). */
  const SKIPS_APPROVALS = skipsApprovals();

  const candidate = input && typeof input === "object" && "client" in input ? input.client : undefined;
  const client = candidate && typeof candidate === "object" ? /** @type {ReporterClient} */ (candidate) : undefined;

  /** State one fact about this pane.
   *
   * The handler is not kept waiting — it hands the envelope over and returns.
   * What waits is the next POST, so the deck reads these facts in the order
   * the bus stated them; see `publish` in keepdeck-bridge.js for why that
   * ordering is not free. */
  /** @param {string} type @param {Record<string, unknown>} payload */
  const publish = (type, payload) => {
    publishEnvelope(bridge, makeEnvelope(bridge, type, payload));
  };

  // What the conversation SPENT is its steps: each `step-finish` part is one
  // model call, with an id of its own and its own counts — the message a
  // step belongs to carries only its LAST step's counts, so reading messages
  // undercounted every multi-step turn. A step names its message, and the
  // message names the model and when it began: kept here by message id, for
  // the conversation and its subagents. A step read before its message's
  // first frame waits for it.
  /** @type {Map<string, { providerID: string, modelID: string, created: number }>} */
  const metas = new Map();
  /** @type {Map<string, StepPart[]>} */
  const waiting = new Map();
  /** Steps learned and not yet reported.
   * @type {import("./pane-report.js").Step[]} */
  let unreported = [];
  // Which session is the pane's conversation, and which of the others are
  // subagents' — ONE object, shared with the mail courier beside this file.
  // Two answers to that question means the deck watching one session's turns
  // while mail lands in another.
  const pane = paneSession(parentLookupV1(client));
  // The latest ROOT assistant turn — defines occupancy/identity, not spend.
  /** @type {{ sessionID: string, providerID?: string, modelID?: string, completedAt: number, turn: TokenCounts } | undefined} */
  let root;
  let sequence = 0;
  /** @type {Promise<void> | undefined} */
  let hydration;

  /** @param {MessageInfo | undefined} info */
  const turnOf = (info) => tokenCounts(info?.tokens);

  /** Note what an assistant message of the conversation ran on and when it
   * began, from any of its frames — and release the steps that waited for
   * it. Answers whether any did. */
  /** @param {MessageInfo | undefined} value */
  const noteMessage = (value) => {
    const info = value?.info ?? value;
    if (info?.role !== "assistant" || !info.id || !info.providerID || !info.modelID) return false;
    const created = info.time?.created;
    if (typeof created !== "number") return false;
    metas.set(info.id, { providerID: info.providerID, modelID: info.modelID, created });
    const held = waiting.get(info.id);
    if (!held) return false;
    waiting.delete(info.id);
    for (const part of held) learnStep(part);
    return true;
  };

  /** One finished step, reported once its message is known. */
  /** @param {StepPart} part */
  const learnStep = (part) => {
    const meta = metas.get(part.messageID);
    if (!meta) {
      waiting.set(part.messageID, [...(waiting.get(part.messageID) ?? []), part]);
      return;
    }
    unreported.push({
      id: part.id,
      sessionID: part.sessionID,
      providerID: meta.providerID,
      modelID: meta.modelID,
      created: meta.created,
      tokens: part.tokens ?? {},
    });
  };

  /** A `step-finish` part, or undefined for any other part. */
  /** @param {unknown} value @returns {StepPart | undefined} */
  const stepPart = (value) => {
    if (!value || typeof value !== "object") return undefined;
    const part = /** @type {Record<string, unknown>} */ (value);
    return part.type === "step-finish" &&
      typeof part.id === "string" &&
      typeof part.messageID === "string" &&
      typeof part.sessionID === "string"
      ? /** @type {StepPart} */ (part)
      : undefined;
  };

  /** @param {MessageInfo | undefined} value @returns {CompletedInfo | undefined} */
  const completedAssistant = (value) => {
    const info = value?.info ?? value;
    return info?.role === "assistant" && info?.time?.completed && info?.id && info.sessionID
      ? /** @type {CompletedInfo} */ (info)
      : undefined;
  };

  /**
   * The pane's newest assistant message — the turn a finished message is
   * allowed to speak for.
   *
   * A cancelled turn goes on publishing while it unwinds: opencode frees the
   * session the moment the cancel is accepted, so the aborted message's own
   * record is written seconds later, after the next turn has begun. Without
   * this it ends a turn it was never about.
   *
   * Newest by the message's own CREATION — one Esc can abort several and
   * their records settle out of order — and by ID, not by clock: comparing
   * finish times against the deck's phase misses one abort in fifteen.
   */
  /** @type {{ id: string, created: number } | undefined} */
  let newestTurn;

  /** Record an assistant message of the pane's conversation as its turn.
   * Every frame counts, streaming ones included — the point is to know the
   * NEW turn's message before the old turn's record arrives, and creation is
   * the earliest that can be known. */
  /** @param {MessageInfo | undefined} value */
  const noteTurn = (value) => {
    const info = value?.info ?? value;
    if (info?.role !== "assistant" || !info.id) return;
    if (info.sessionID !== pane.root) return;
    const created = info.time?.created ?? 0;
    if (newestTurn && created < newestTurn.created) return;
    newestTurn = { id: info.id, created };
  };

  /** Whether a finished message is the turn the pane is on now. Nothing
   * recorded means nothing newer has begun — an unbound pane, or the first
   * message of a resumed one — so the message speaks for itself. */
  /** @param {CompletedInfo} info */
  const isNewestTurn = (info) => !newestTurn || newestTurn.id === info.id;

  /** A finished ROOT message is the turn whose context the pane holds now. */
  /** @param {CompletedInfo} info @param {string} rootSessionID */
  const remember = (info, rootSessionID) => {
    const turn = turnOf(info);
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

  /** @param {unknown} response */
  const responseData = (response) => response && typeof response === "object" && "data" in response ? response.data : response;

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
  /** @param {string} sessionID */
  const forSession = (sessionID) => ({ path: { id: sessionID } });

  /** Best-effort full-session hydration: the context a resumed pane holds,
   * and every step the conversation and its subagents made — the deck books
   * each once, and only what is newer than when it first saw the session —
   * without reading opencode's private SQLite. */
  /** @param {string} sessionID @param {string} rootSessionID @param {Set<string>} seen */
  const hydrateSession = async (sessionID, rootSessionID, seen) => {
    if (!sessionID || seen.has(sessionID)) return;
    seen.add(sessionID);
    if (client?.session?.messages) {
      try {
        const result = await client.session.messages(forSession(sessionID));
        const rows = responseData(result);
        if (Array.isArray(rows)) {
          for (const row of rows) {
            noteMessage(row);
            const info = completedAssistant(row);
            if (info) remember(info, rootSessionID);
            const parts = row && typeof row === "object" && "parts" in row ? row.parts : undefined;
            for (const part of Array.isArray(parts) ? parts : []) {
              const step = stepPart(part);
              if (step) learnStep(step);
            }
          }
        }
      } catch {
        // Live events still report every step from here on.
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
  /** @param {string} sessionID @param {boolean} continuing @param {boolean | undefined} switched */
  const bind = (sessionID, continuing, switched) =>
    publish("session.bound", boundReport(sessionID, continuing, switched));

  /**
   * Take a session as the pane's conversation, then set up for it.
   *
   * `keep` is the ancestry already established for the session being bound
   * THROUGH — a descendant whose chain was learned on the way in. Its presence
   * is the difference between the two things the first half does: binding to a
   * conversation already in progress keeps what is known about it, while a
   * root the pane just watched appear owns nothing from the last one.
   */
  /** @param {string} sessionID @param {boolean} publishBinding @param {Array<[string, string]>} [keep] */
  const activateRoot = async (sessionID, publishBinding, keep) => {
    if (keep) pane.bindFromChain(sessionID, keep);
    else pane.newGeneration(sessionID);
    await setUpForConversation(publishBinding);
    // The steps hydration found of a conversation in progress are owed at
    // once: a pane that never speaks again would otherwise never tell them.
    if (unreported.length > 0) await reportUsage();
  };

  /**
   * Everything this reporter owes a conversation it has not served yet.
   *
   * KEYED ON WHICH CONVERSATION, NOT ON WHO MOVED IT THERE. Both components watch
   * the same `session.created` on their own queues, and the courier's is free
   * to run while this one waits on hydration or on the provider catalog — so
   * the courier can be the one that sets the new root. Gating this on having
   * performed the move lost all of it in that window: no binding published, so
   * the deck no longer knows which session the pane is; no accumulators
   * cleared, so a new conversation inherited the last one's spend; no
   * hydration. None of it visible from either side.
   *
   * The id is the whole key, and no counter is needed beside it: what has to
   * be answered is "is this the conversation I already set up for", and a
   * comparison answers it. It would answer it even for a pane that somehow
   * came back to a conversation it had left — the ids need no order for this,
   * only difference.
   *
   * `continuing` comes from THIS reporter's own history rather than from the
   * pane being bound, for the same reason — the courier may have bound it
   * already, and then a first conversation would report itself as a second.
   */
  /** @type {string | undefined} */
  let servedRoot;
  /** @param {boolean} publishBinding @param {boolean} [switched] */
  const setUpForConversation = async (publishBinding, switched = false) => {
    if (pane.root === undefined || pane.root === servedRoot) return;
    // The steps of the conversation being left are its spend: reported while
    // the deck still has it as the pane's, before the binding moves.
    if (unreported.length > 0) await reportUsage();
    const continuing = servedRoot !== undefined;
    servedRoot = pane.root;
    root = undefined;
    sequence = 0;
    if (publishBinding) bind(servedRoot, continuing, switched);
    hydration = hydrateSession(servedRoot, servedRoot, new Set());
    await hydration;
  };

  // (providerID, modelID) → context-window size, resolved lazily from the
  // provider catalog and cached ONCE ON SUCCESS. OpenCode model ids are not
  // globally unique; flattening by modelID alone selects another provider's
  // context limit. An in-flight promise makes the fetch single-flight.
  const contextWindow = createWindowCache(async () => {
    if (!client?.config?.providers) throw new Error("no client to ask");
    const res = await client.config.providers();
    const providers = res?.data?.providers ?? res?.providers ?? [];
    return providers.flatMap((provider) => {
      const providerID = provider?.id;
      if (!providerID) return [];
      return Object.entries(provider.models ?? {}).map(([modelID, model]) => ({
        providerID,
        modelID,
        window: model?.limit?.context,
      }));
    });
  });

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
  /** @param {ReporterEvent} event */
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
   * The last thing this side said about whether the pane's turn is running.
   *
   * opencode repeats BOTH turn-state facts — `busy` once per model call, and
   * `idle` twice per abort, because quiescence has two owners announcing it —
   * so a repeat of either is the same kind of nothing, under one rule.
   *
   * ONLY THE OPPOSITE FACT MAKES EITHER NEWS AGAIN. Errors must not: some end
   * no turn at all, and clearing on one restarts the phase clock on a turn
   * that never stopped.
   *
   * NOT COVERED: a new turn's `busy` landing between the two idles would let
   * the second through, and an `idle` payload carries nothing to tell it from
   * the first.
   */
  /** @type {"busy" | "idle" | undefined} */
  let lastTurnState;

  /** @param {ReporterEvent} event */
  const belongsHere = (event) => {
    const props = event.properties ?? {};
    switch (event.type) {
      case "session.status":
      case "session.idle":
        return !!props.sessionID && pane.concernsPane(props.sessionID);
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

  /** Which of the two turn-state facts an event states, if either. The `idle`
   * KIND of `session.status` is not one of them: it is the first half of a
   * pair whose second half is `session.idle`, and counting it would make the
   * real ending look like a repeat of itself. What a fact MEANS stays the
   * normalizer's. */
  /** @param {ReporterEvent} event */
  const turnStateOf = (event) => {
    if (event.type === "session.idle") return "idle";
    if (event.type !== "session.status") return undefined;
    const status = event.properties?.status;
    const kind = typeof status === "object" ? status?.type : status;
    return kind === "busy" ? "busy" : undefined;
  };

  /** @param {ReporterEvent} event */
  const handle = async (event) => {
    if (belongsHere(event)) {
      const stating = turnStateOf(event);
      // Already said, and nothing has said otherwise since — see
      // `lastTurnState` for what each repeat costs the deck.
      if (!stating || stating !== lastTurnState) {
        forward(event);
        if (stating) lastTurnState = stating;
      }
      // The ending of a conversation the user left: told to the deck as the
      // pane's (or already told — an idle session's abort only repeats it),
      // and only now does the pane let it go.
      if (event.type === "session.idle" && event.properties?.sessionID) leaving.ended(event.properties.sessionID);
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

    // A finished step of the pane's conversation or its subagents: one call.
    // Before the pane is bound there is nothing to book it under — binding
    // hydrates the conversation, its steps included.
    if (event?.type === "message.part.updated") {
      const step = stepPart(event.properties?.part);
      if (!step || !pane.bound || pane.rootOf(step.sessionID) !== pane.root) return;
      learnStep(step);
      await reportUsage();
      return;
    }

    if (event?.type !== "message.updated") return;
    noteTurn(event.properties);
    // Steps that waited for this message's model go out now, finished or not.
    if (noteMessage(event.properties)) await reportUsage();
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
    //
    // Nor is a SUPERSEDED message the pane's turn ending: see `newestTurn`.
    // Spend below is unaffected — a late record is still real money, and the
    // sum is keyed by message id rather than by which turn is current.
    if (info.sessionID === pane.root && isNewestTurn(info)) forward(event);
    if (hydration) await hydration;
    // A subagent's context is ITS own, not the pane's conversation, so only
    // a ROOT turn sets occupancy. Its spend travels as its steps.
    remember(info, pane.root);
    await reportUsage();
  };

  /** The conversation's context and the steps it made since the last
   * report, as `usage.report`s — the steps in reports of a bounded size;
   * nothing when there is neither a root turn nor a step to tell. */
  const reportUsage = async () => {
    if (!root && unreported.length === 0) return;
    // Immutable report basis before the async catalog lookup. The queue below
    // serializes callbacks too, but capturing keeps this function locally sane.
    const currentRoot = root;
    const steps = unreported;
    unreported = [];
    const windowTokens = currentRoot
      ? await contextWindow(currentRoot.providerID, currentRoot.modelID)
      : undefined;
    let from = 0;
    do {
      publish(
        "usage.report",
        usageReport({
          sessionId: currentRoot?.sessionID,
          sequence: ++sequence,
          windowTokens,
          lastTurn: currentRoot?.turn,
          steps: steps.slice(from, from + STEPS_PER_REPORT),
        }),
      );
      from += STEPS_PER_REPORT;
    } while (from < steps.length);
  };

  // OpenCode deliberately does not await plugin event promises. Reduce every
  // event through our own queue so hydration/catalog IO cannot interleave two
  // mutations or let an older snapshot publish after a newer one.
  let eventQueue = Promise.resolve();
  /** @param {() => Promise<void>} job */
  const enqueue = (job) => {
    eventQueue = eventQueue.then(job).catch(() => {});
    return eventQueue;
  };

  /**
   * The user left the pane's conversation (follower.js): on 1.x its running
   * turn is aborted — subagents and all — and, left for no conversation, the
   * pane lets go of it once the abort's ending reached the deck (leaving.js).
   */
  const leaving = createLeaving({
    pane,
    publish,
    enqueue,
    interrupt: async (sessionID) => client?.session?.abort?.({ path: { id: sessionID } }),
    onLetGo: () => {
      lastTurnState = undefined;
    },
  });
  follower().onLeave(leaving.leave);

  /**
   * The user opened another session in the TUI (follower.js), and the pane
   * moves there — as ONE job in this queue, so the deck hears the binding
   * before any event of the session it names, and the session's spend right
   * after it rather than at its next finished turn. What this side last said
   * about a turn belonged to the session left behind.
   */
  follower().onMove((sessionID) =>
    enqueue(async () => {
      pane.newGeneration(sessionID);
      lastTurnState = undefined;
      await setUpForConversation(true, true);
      await reportUsage();
    }),
  );

  return {
    /** @param {{ event: ReporterEvent }} input */
    event: ({ event }) => enqueue(() => handle(event)),
  };
}
