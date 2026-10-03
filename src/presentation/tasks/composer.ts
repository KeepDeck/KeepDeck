/**
 * The comment composer's life: what is typed, what is in flight, and what
 * a finished send may clear — only the text it sent, and only when it was
 * accepted. Typing while a send is out is kept: a person who added to the
 * draft has not sent that yet.
 */
import { normalizeLabel } from "../../domain/tasks";
import { canSendComment } from "./composerView";

export interface ComposerState {
  draft: string;
  /** The text in flight, or null while nothing is. */
  sending: string | null;
}

export const EMPTY_COMPOSER: ComposerState = { draft: "", sending: null };

export function typeDraft(state: ComposerState, text: string): ComposerState {
  return { ...state, draft: text };
}

export function composerCanSend(state: ComposerState): boolean {
  return canSendComment(state.draft, state.sending !== null);
}

/** Start sending the draft — or nothing, when it may not be sent now. */
export function beginSend(state: ComposerState): { state: ComposerState; body: string } | null {
  if (!composerCanSend(state)) return null;
  return { state: { ...state, sending: state.draft }, body: state.draft };
}

/** The send came back. Accepted, it clears the draft — unless the draft
 * has moved on since; refused, it keeps everything. */
export function finishSend(state: ComposerState, accepted: boolean): ComposerState {
  const cleared = accepted && state.draft === state.sending;
  return { draft: cleared ? "" : state.draft, sending: null };
}

/** Whether the label field holds something to add: a word once kept the
 * board's way — Enter on an empty or all-dash field sends nothing. */
export function labelSendable(draft: string): boolean {
  return normalizeLabel(draft) !== "";
}

/** The label field after an add settles: cleared when it landed — but only
 * of what was sent, never of what was typed since (the composer's rule). */
export function labelDraftAfter(current: string, sent: string, landed: boolean): string {
  return landed && current === sent ? "" : current;
}
