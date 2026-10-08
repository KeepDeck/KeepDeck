/**
 * What the welcome screen says — the screen KeepDeck shows while it has no
 * workspace: who it greets, the one-line pitch, the steps that name its
 * words (a workspace is a folder, a team works in it, tasks go to the
 * team), the agents this machine has, and the projects agents have worked
 * in, newest first — the first few, or all of them once asked.
 */
import { formatAge } from "../domain/usage";
import { baseName, homeRelative } from "../domain/deck";
import type { RecentProject } from "../domain/recentProject";
import type { AgentIcon } from "../domain/agents";

/** How many recent projects show before "Show all…". */
export const WELCOME_RECENT_FIRST = 5;

/** First-paint height of a project row (two lines and their padding) —
 * the windowed list corrects it once the row is measured. */
export const WELCOME_ROW_ESTIMATE_PX = 52;

export const WELCOME_WORDS = {
  firstTitle: "Welcome to KeepDeck",
  backTitle: "Welcome back",
  pitch: "Run teams of coding agents on your projects — side by side, with a shared board of tasks.",
  open: "Open a project folder…",
  hint: "A workspace is one project folder.",
  /** The New Workspace command's key, beside the way in it opens. */
  shortcut: "⌘N",
  agentsFound: "Agents found:",
  noAgents: "No coding agents found on this machine yet.",
  recentHeading: "Recent projects",
  recentCaption: "where your agents worked",
  showAll: "Show all…",
} as const;

export const WELCOME_STEPS: readonly { title: string; text: string }[] = [
  { title: "Open a folder", text: "it becomes a workspace." },
  { title: "Start a team", text: "agents that work in it together." },
  { title: "Hand out tasks", text: "on the team's board." },
];

export interface WelcomeProjectRow {
  key: string;
  /** The folder the project opens — what a click hands on. */
  dir: string;
  name: string;
  path: string;
  sessions: string;
  age: string;
}

export interface WelcomeView {
  /** The screen's classes: one column, or two with the projects beside. */
  className: string;
  title: string;
  pitch: string;
  open: string;
  hint: string;
  shortcut: string;
  steps: readonly { title: string; text: string }[];
  /** Every agent KeepDeck knows, found on this machine or not. */
  agents: { label: string; items: { name: string; icon: AgentIcon | null; className: string }[] };
  recent: {
    heading: string;
    caption: string;
    rows: WelcomeProjectRow[];
    rowEstimate: number;
    /** The "Show all…" offer, while some are not shown. */
    more: string | null;
  } | null;
}

export function welcomeView(input: {
  projects: readonly RecentProject[];
  /** The home folder: a path under it is shown under `~`. */
  home: string | null;
  showAll: boolean;
  agents: readonly { label: string; installed: boolean; icon?: AgentIcon }[];
  now: number;
}): WelcomeView {
  const { projects } = input;
  const shown = input.showAll ? projects : projects.slice(0, WELCOME_RECENT_FIRST);
  const anyFound = input.agents.some((agent) => agent.installed);
  return {
    className: projects.length > 0 ? "welcome welcome--with-recent" : "welcome",
    // Back to work there is to come back to: the same fact the list shows.
    title: projects.length > 0 ? WELCOME_WORDS.backTitle : WELCOME_WORDS.firstTitle,
    pitch: WELCOME_WORDS.pitch,
    open: WELCOME_WORDS.open,
    hint: WELCOME_WORDS.hint,
    shortcut: WELCOME_WORDS.shortcut,
    steps: WELCOME_STEPS,
    agents: {
      label: anyFound ? WELCOME_WORDS.agentsFound : WELCOME_WORDS.noAgents,
      items: input.agents.map((agent) => ({
        name: agent.label,
        icon: agent.icon ?? null,
        className: agent.installed ? "kd-tag kd-tag--outline welcome__agent" : "kd-tag kd-tag--outline welcome__agent welcome__agent--missing",
      })),
    },
    recent:
      projects.length === 0
        ? null
        : {
            heading: WELCOME_WORDS.recentHeading,
            caption: WELCOME_WORDS.recentCaption,
            rows: shown.map((project) => ({
              key: project.root,
              dir: project.root,
              name: baseName(project.root) || project.root,
              path: homeRelative(project.root, input.home),
              sessions: project.sessions === 1 ? "1 session" : `${project.sessions} sessions`,
              age: formatAge(project.lastAt, input.now),
            })),
            rowEstimate: WELCOME_ROW_ESTIMATE_PX,
            more: shown.length < projects.length ? WELCOME_WORDS.showAll : null,
          },
  };
}
