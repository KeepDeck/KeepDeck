import {
  isJsonRecord,
  turnFailedEvent,
  type AgentStatusEvent,
  type StatusNormalizer,
} from "@keepdeck/plugin-api";

/**
 * opencode's bus, read as turn-lifecycle edges.
 *
 * THE ONLY PLACE OPENCODE'S DIALECT IS TRANSLATED. The reporter inside the
 * agent's process forwards its events verbatim and answers only questions of
 * ADDRESS about them — whose conversation an event belongs to, and which of
 * the pane's turns — because the session tree, the process boundary and the
 * order in which messages were opened exist only there. What an event MEANS
 * is decided here, where a reading can be revised; a payload reduced a
 * process away cannot be.
 *
 * INTERRUPTS ARE DISTINGUISHABLE, and the comment that used to stand here
 * said the opposite. `MessageAbortedError` is a typed member of the error
 * union and arrives on every measured abort — 12 runs of 12, published BEFORE
 * the idle pair that follows it, by the CLI's own ordering. Reading every
 * error as a failure is what put `Failed: MessageAbortedError` on a pane whose
 * user had simply pressed Esc.
 *
 * ARRIVAL ORDER IS NOT ASSUMED. An abort states its error and its ending a
 * fraction of a millisecond apart, and the host keeps whichever lands first.
 * The reporter posts one at a time so the pair keeps the order the bus gave
 * it; nothing here depends on that, because a rule that has to ask who came
 * first is a rule with a race inside it.
 */
export const normalizeOpencodeStatus: StatusNormalizer = (
  payload,
  at,
): AgentStatusEvent | null => {
  if (!isJsonRecord(payload) || !isJsonRecord(payload.event)) return null;
  const event = payload.event;
  const properties = isJsonRecord(event.properties) ? event.properties : {};
  switch (event.type) {
    case "session.status":
      return sessionStatusEdge(properties.status, at);
    case "session.idle":
      return { kind: "turn-end", at };
    case "session.error":
      return sessionErrorEdge(properties.error, at);
    case "message.updated":
      return finishedMessageEdge(properties.info ?? properties, at);
    case "permission.asked":
      return { kind: "waiting", at, reason: "permission" };
    case "question.asked":
      // The agent put a choice in front of the user and the turn is standing
      // on it — and NOTHING else on the bus says so: no idle, no status
      // change, the runner stays busy for as long as the dialog is up. Before
      // this edge the pane read "Working" while the terminal waited.
      return { kind: "waiting", at, reason: "question" };
    case "permission.replied":
    case "question.replied":
    case "question.rejected":
      // Every answer resumes, including the refusing ones. A denied tool call
      // is still a turn in flight — the model receives the refusal, says
      // something about it, and the turn ends through its own idle. Reading a
      // refusal as an ending would mint the end twice and read the user's
      // "no" as a breakdown.
      return { kind: "resumed", at };
    default:
      return null;
  }
};

/**
 * `session.status` carries the runner's state as an object of three kinds.
 *
 * `busy` is the only one that opens a turn. The `idle` kind is the first half
 * of a pair whose second half is the `session.idle` event — minting an ending
 * for both would close every turn twice.
 *
 * `retry` is a LIVE turn: the model call failed with something retryable, and
 * the same step is waiting to run again. No error event accompanies it — the
 * retry window is the only word the bus says about a turn that is stalling
 * rather than working. Dropped for now, deliberately and with the cost named:
 * the pane goes on reading "Working", which is true but incurious.
 */
function sessionStatusEdge(
  status: unknown,
  at: number,
): AgentStatusEvent | null {
  const kind = isJsonRecord(status) ? status.type : status;
  return kind === "busy" ? { kind: "turn-start", at } : null;
}

/**
 * What one error NAME means for the turn behind it.
 *
 * Three fates, not two. A turn can die, a turn can end without being broken,
 * and — the one that reading names as failures got wrong — a turn can carry
 * on: an overflowed context publishes its error and then compacts, with no
 * idle behind it, so calling that a failure announces the death of something
 * still running.
 *
 * A table rather than branches, so a name opencode adds later is a row here
 * and not a new shape of logic. An unknown name is a failure, which is the
 * honest default: the names below are the ones whose fates are known, and
 * everything else that reaches this event did break something.
 */
const NOT_A_FAILURE: Record<string, "interrupted" | "ended" | "alive"> = {
  // The user's hand, or any other — the name means "the fiber was
  // interrupted", which also covers an instance shutting down mid-turn.
  MessageAbortedError: "interrupted",
  // The provider refused the content. The turn is over and nothing is
  // broken; it ends through its own idle.
  ContentFilterError: "ended",
  // Published, then compaction runs and the SAME turn continues. No idle
  // follows this one.
  ContextOverflowError: "alive",
};

function sessionErrorEdge(error: unknown, at: number): AgentStatusEvent | null {
  const name = isJsonRecord(error) ? error.name : undefined;
  const fate = typeof name === "string" ? NOT_A_FAILURE[name] : undefined;
  if (fate === "interrupted") return { kind: "interrupted", at };
  // "ended" leans on the idle that follows; "alive" must not speak at all.
  if (fate !== undefined) return null;
  const data = isJsonRecord(error) ? error.data : undefined;
  const message = isJsonRecord(data) ? data.message : undefined;
  return turnFailedEvent(at, name, message);
}

/**
 * A finished assistant message, read for the ending that no event carries.
 *
 * An interrupt caught BETWEEN steps writes its name onto the message and
 * publishes no `session.error` at all — the idle pair still arrives, so
 * without this anchor that turn reads as an ordinary, successful Done. That
 * path is opencode's own code and not a guess: the finalizer for an assistant
 * message interrupted outside the model stream sets the error, stamps the
 * message finished and rewrites it, and publishes nothing else. It has never
 * been caught in the act on a live agent — every window we managed to
 * interrupt published the error too — so the anchor stays written as
 * insurance, and costs one comparison.
 *
 * WHICH TURN a record is about is settled before it reaches here. opencode
 * frees the session the moment a cancel is accepted and finishes unwinding
 * afterwards, so an aborted message's record can be written after the next
 * turn has begun; the reporter forwards one only while it is still the pane's
 * own newest message.
 *
 * THE GUARD IS THE POINT. An ordinary turn also finishes, and it finishes
 * without an error — so an anchor that triggered on completion alone would
 * turn every honest ending into a false "Interrupted". Both halves are
 * required: finished, AND carrying a name.
 *
 * A name that is not about interruption is left alone. opencode keeps the
 * FIRST error a message was given, so a turn that was already failing when
 * the user cut it still carries the failure's name — and that is the truth
 * about it. The `session.error` published at the time already said so.
 */
function finishedMessageEdge(
  info: unknown,
  at: number,
): AgentStatusEvent | null {
  if (!isJsonRecord(info)) return null;
  const time = isJsonRecord(info.time) ? info.time : undefined;
  if (typeof time?.completed !== "number") return null;
  const error = isJsonRecord(info.error) ? info.error : undefined;
  if (error?.name === "MessageAbortedError") return { kind: "interrupted", at };
  return null;
}
