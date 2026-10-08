import { useCallback, useReducer } from "react";
import { WELCOME_AT_START, welcomeStep, type WelcomeState } from "../presentation/welcomeFlow";

/** The welcome screen's flow, wired: its steps are `welcomeStep`'s; this
 * holds the one state and asks the OS for a folder. Held by the app
 * controller, so the New Workspace command (⌘N) at no workspace opens the
 * same picker the screen's button does. */
export interface WelcomeFlow {
  state: WelcomeState;
  /** The picker; its folder, if one comes back, goes to the confirm step. */
  openFolder(): void;
  /** A recent project clicked: straight to confirming it. */
  choose(dir: string): void;
  back(): void;
  showAll(): void;
  /** A workspace was made: the next time there is none, start over. */
  reset(): void;
}

export function useWelcomeFlow(pickFolder: (title: string) => Promise<string | null>): WelcomeFlow {
  const [state, dispatch] = useReducer(welcomeStep, WELCOME_AT_START);
  const openFolder = useCallback(() => {
    void pickFolder("Choose a project folder").then((dir) => dispatch({ type: "picked", dir }));
  }, [pickFolder]);
  const choose = useCallback((dir: string) => dispatch({ type: "picked", dir }), []);
  const back = useCallback(() => dispatch({ type: "back" }), []);
  const showAll = useCallback(() => dispatch({ type: "showAll" }), []);
  const reset = useCallback(() => dispatch({ type: "reset" }), []);
  return { state, openFolder, choose, back, showAll, reset };
}
