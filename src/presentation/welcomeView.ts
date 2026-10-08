/**
 * What the welcome screen says — the screen KeepDeck shows while it has no
 * workspace: who it greets, the one-line pitch, the steps that name its
 * words (a workspace is a folder, a team works in it, tasks go to the
 * team), the agents this machine has, and the projects agents have worked
 * in, newest first — the first few, or all of them once asked.
 */
import { formatAge } from "../domain/usage";
import { baseName } from "../domain/deck";
import type { RecentProject } from "../domain/recentProject";

/** How many recent projects show before "Show all…". */
export const WELCOME_RECENT_FIRST = 5;

export const WELCOME_WORDS = {
  firstTitle: "Welcome to KeepDeck",
  backTitle: "Welcome back",
  pitch: "Run teams of coding agents on your projects — side by side, with a shared board of tasks.",
  open: "Open a project folder…",
  hint: "A workspace is one project folder.",
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
  title: string;
  pitch: string;
  open: string;
  hint: string;
  steps: readonly { title: string; text: string }[];
  agents: { label: string; names: string[] } | { label: string; names: null };
  recent: {
    heading: string;
    caption: string;
    rows: WelcomeProjectRow[];
    /** The "Show all…" offer, while some are not shown. */
    more: string | null;
  } | null;
}

export function welcomeView(input: {
  projects: readonly RecentProject[];
  showAll: boolean;
  agents: readonly { label: string; installed: boolean }[];
  now: number;
}): WelcomeView {
  const { projects } = input;
  const shown = input.showAll ? projects : projects.slice(0, WELCOME_RECENT_FIRST);
  const found = input.agents.filter((agent) => agent.installed).map((agent) => agent.label);
  return {
    // Back to work there is to come back to: the same fact the list shows.
    title: projects.length > 0 ? WELCOME_WORDS.backTitle : WELCOME_WORDS.firstTitle,
    pitch: WELCOME_WORDS.pitch,
    open: WELCOME_WORDS.open,
    hint: WELCOME_WORDS.hint,
    steps: WELCOME_STEPS,
    agents: found.length > 0 ? { label: WELCOME_WORDS.agentsFound, names: found } : { label: WELCOME_WORDS.noAgents, names: null },
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
              path: project.root,
              sessions: project.sessions === 1 ? "1 session" : `${project.sessions} sessions`,
              age: formatAge(project.lastAt, input.now),
            })),
            more: shown.length < projects.length ? WELCOME_WORDS.showAll : null,
          },
  };
}
