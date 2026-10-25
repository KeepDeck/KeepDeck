/**
 * How a pane's opencode opens a recorded session — resumed, or forked into
 * the pane's directory — per generation, behind the one check both share
 * (whereabouts.ts): the store is asked first where the session lives, and a
 * session this opencode would open as something else is refused in words.
 */
import {
  errorMessage,
  type ForkPlanInput,
  type ResumeLaunch,
  type ResumePlanInput,
} from "@keepdeck/plugin-api";
import { forkInto, type ForkPorts, type ForkRequest } from "./fork";
import { recipeV1, recipeV2 } from "./forkRecipe";
import { opencodeStore, type StorePorts } from "./store";
import { generationOf, type Generation } from "./version";
import { missingFrom, refusalOf, verdictOn } from "./whereabouts";

/**
 * 2.x: `-s`, and the same id in the environment.
 *
 * Under `--standalone` KeepDeck's plugin runs in the child `opencode serve`
 * the TUI starts, whose arguments carry no `-s` — but the environment passes
 * through (measured, task-382). Without it the pane stays unbound until the
 * resumed session says something, and the deck's ring delivers nothing in
 * the meantime: mail waits for the user's own turn.
 */
export const OPENCODE_SESSION_ENV = "KEEPDECK_OPENCODE_SESSION";

/** One generation's way to open a recorded session. */
interface Opener {
  resume(sessionId: string): ResumeLaunch;
  fork(ports: ForkPorts, request: ForkRequest): Promise<string>;
  /** Whether `-s` with an id the store does not have makes a new, empty
   * session under it instead of refusing (2.x; 1.x exits). */
  makesMissing: boolean;
}

const OPENERS: Record<Generation, Opener> = {
  1: {
    resume: (sessionId) => ["-s", sessionId],
    fork: (ports, request) => forkInto(ports, recipeV1, request),
    makesMissing: false,
  },
  2: {
    resume: (sessionId) => ({
      args: ["-s", sessionId],
      env: [[OPENCODE_SESSION_ENV, sessionId]],
    }),
    fork: (ports, request) => forkInto(ports, recipeV2, request),
    makesMissing: true,
  },
};

/** What opening a session needs from the host: the store, and a fork's. */
export type OpeningPorts = ForkPorts & StorePorts;

type Opening = Pick<ResumePlanInput, "sessionId" | "cliVersion">;

export function sessionOpening(ports: OpeningPorts) {
  const store = opencodeStore(ports);

  /** Why `input`'s session cannot be opened by this generation — undefined
   * when it can, or when it is in neither table set and `nowhereAsked` is
   * false (opencode says so itself then). A store that cannot be read
   * leaves the answer to opencode: the check never stands in the way of an
   * opencode it knows nothing about. */
  const refusal = async (input: Opening, generation: Generation, nowhereAsked: boolean) => {
    let verdict;
    try {
      verdict = verdictOn(generation, await store.locate(input.sessionId));
    } catch (cause) {
      ports.log.warn(`opencode: where ${input.sessionId} lives is unknown: ${errorMessage(cause)}`);
      return undefined;
    }
    if (verdict === "nowhere" && !nowhereAsked) return undefined;
    return refusalOf(verdict, generation, input.cliVersion, input.sessionId);
  };

  return {
    async resume(input: ResumePlanInput): Promise<ResumeLaunch> {
      const generation = generationOf(input.cliVersion);
      const opener = OPENERS[generation];
      const refused = await refusal(input, generation, opener.makesMissing);
      if (refused) throw new Error(refused);
      return opener.resume(input.sessionId);
    },

    async fork(input: ForkPlanInput): Promise<readonly string[]> {
      const generation = generationOf(input.cliVersion);
      const refused = await refusal(input, generation, false);
      if (refused) throw new Error(refused);
      const forked = await OPENERS[generation].fork(ports, {
        ...input,
        missing: missingFrom(generation, input.cliVersion, input.sessionId),
      });
      // The clone is a session of its own now, opened as any other; the
      // launch flags are already on the plan (launch.ts).
      return ["-s", forked];
    },
  };
}
