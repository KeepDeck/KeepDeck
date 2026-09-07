/**
 * What the command surface is given — the ONE injection contract every
 * command module shares, in a module of its own so the modules can depend on
 * it without depending on the composition root that assembles them.
 */
import {
  type AgentInfo,
} from "../../domain/agents";
import type { PaneActivity } from "../../domain/status";
import type {
  CreatePaneOutcome,
  CreatePaneRequest,
  CreateTeamOutcome,
  CreateTeamRequest,
  ResumeRequest,
} from "../agentOrchestrator";
import type { SkillsLibrary } from "../skillsLibrary";
import type { SuspendOutcome } from "../suspendOutcome";
import type { Deck } from "../useDeck";

/**
 * The deck's core command set — what any invoker (voice, MCP, hotkeys, a
 * future palette) can do to the deck through the command registry. The plain
 * application controller registers once; accessors read the current store and
 * current UI port for every invocation. This is the STATIC registration
 * lifecycle; feature-gated command sets have their own register/dispose
 * lifecycle. The split is deliberate: a feature toggle must not re-register
 * or tear down the core set.
 */

export interface CoreCommandDeps {
  deck(): Deck;
  agents(): AgentInfo[];
  /** What a pane's agent is doing, when anything reports for it.
   *
   * The roster carries it because the deck can SEE this from outside and a
   * session cannot see it at all. An agent that has to ask a teammate "are
   * you done yet?" spends a turn, waits for a reply, and pays for both — so
   * every question the host can already answer belongs in the answer it
   * gives for free. */
  activityOf(paneId: string): PaneActivity | undefined;
  /** Select a pane and hand keyboard input to its live terminal. */
  activatePane(wsId: string, paneId: string): void;
  /** Open the close-confirm flow — voice/MCP closes go through the same
   * dialog as ⌘W, so the destructive step keeps its human confirmation. */
  requestCloseAgent(wsId: string, paneId: string, label: string): void;
  /** Stop an agent, keeping its pane — the same flow as ⇧⌘W. Resolves to
   * whether it actually suspended. */
  suspendAgent(wsId: string, paneId: string): Promise<SuspendOutcome>;
  /** Ask for a stopped agent back — the same gesture as its card's Resume,
   * reporting what it did. */
  resumeAgent(wsId: string, paneId: string): ResumeRequest;
  /** Land a new agent pane, worktree create and all — the same entry point
   * the agent dialog uses, so a spawn asked for by voice or MCP goes
   * through the same sequence as one asked for by hand. */
  createPane(request: CreatePaneRequest): CreatePaneOutcome;
  /** Make a team that holds a directory and nobody yet — the same door
   * "+ Team" goes through, so a team asked for by voice or MCP is born the
   * way one asked for by hand is: empty, agents to follow one at a time. */
  createTeam(request: CreateTeamRequest): CreateTeamOutcome;
  /** Open the settings dialog; `sectionId` lands it on a specific section
   * (a plugin's `plugin:<id>`), null on the first. Answers whether it opened:
   * a command arrives with no button to have been disabled, so it asks the
   * same "may another dialog open?" gate the UI does, and a refusal that
   * reported success would leave the caller believing a surface is up. */
  openSettings(sectionId: string | null): boolean;
  /** Open the global usage-statistics surface. Same refusal contract as
   * [`openSettings`]. */
  openUsage(): boolean;
  /** The shared skills library, for the `skills.*` set (see `./skills`). */
  skills: SkillsLibrary;
}

/** The refusal when a command asks for a surface that would stack over one
 * already up. One sentence for both openers, because to the caller they are
 * the same refusal for the same reason. */
