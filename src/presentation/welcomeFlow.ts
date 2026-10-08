/**
 * The welcome screen's steps, decided: choosing a project (a folder picked,
 * a recent project clicked) leads to confirming it; Back returns to the
 * choice. A picker closed without a folder changes nothing. The list of
 * recent projects shows its first few until the person asks for all.
 * Pure — the hook beside the screen holds one state and applies these.
 */

export interface WelcomeState {
  step: { kind: "choose" } | { kind: "confirm"; dir: string };
  /** Every recent project shown, not only the first few. */
  showAll: boolean;
}

export const WELCOME_AT_START: WelcomeState = { step: { kind: "choose" }, showAll: false };

export type WelcomeAction =
  /** A folder came back from the picker — null when it was closed. */
  | { type: "picked"; dir: string | null }
  | { type: "back" }
  | { type: "showAll" }
  /** A workspace was made from it: the next welcome starts over. */
  | { type: "reset" };

export function welcomeStep(state: WelcomeState, action: WelcomeAction): WelcomeState {
  switch (action.type) {
    case "picked":
      return action.dir === null ? state : { ...state, step: { kind: "confirm", dir: action.dir } };
    case "back":
      return state.step.kind === "choose" ? state : { ...state, step: { kind: "choose" } };
    case "showAll":
      return state.showAll ? state : { ...state, showAll: true };
    case "reset":
      return WELCOME_AT_START;
  }
}

/** Where New Workspace (⌘N, the strip's «+») leads: with a workspace, the
 * form over the deck; with none, the welcome screen's folder picker — the
 * screen IS the way in, and a form over it would be a second one. */
export function newWorkspaceTarget(workspaceCount: number): "form" | "welcome" {
  return workspaceCount === 0 ? "welcome" : "form";
}
