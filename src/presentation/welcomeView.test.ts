import { describe, expect, it } from "vitest";
import { WELCOME_RECENT_FIRST, WELCOME_STEPS, WELCOME_WORDS, welcomeView } from "./welcomeView";

const DAY = 86_400_000;
const NOW = 100 * DAY;
const project = (root: string, sessions: number, lastAt: number) => ({ root, sessions, lastAt });
const agents = [
  { label: "claude", installed: true },
  { label: "codex", installed: false },
  { label: "kimi", installed: true },
];

describe("what the welcome screen says", () => {
  it("greets a first run and offers no list when agents have worked nowhere yet", () => {
    const view = welcomeView({ projects: [], showAll: false, agents, now: NOW });
    expect(view.title).toBe(WELCOME_WORDS.firstTitle);
    expect(view.recent).toBeNull();
    expect(view.steps).toBe(WELCOME_STEPS);
    expect(view.open).toBe(WELCOME_WORDS.open);
  });

  it("welcomes back where there is work to come back to, each project by its folder's name, sessions and age", () => {
    const view = welcomeView({ projects: [project("/Users/me/KeepDeck", 76, NOW - 3 * DAY), project("/Users/me/x", 1, NOW)], showAll: false, agents, now: NOW });
    expect(view.title).toBe(WELCOME_WORDS.backTitle);
    expect(view.recent?.rows).toEqual([
      { key: "/Users/me/KeepDeck", dir: "/Users/me/KeepDeck", name: "KeepDeck", path: "/Users/me/KeepDeck", sessions: "76 sessions", age: "3d ago" },
      { key: "/Users/me/x", dir: "/Users/me/x", name: "x", path: "/Users/me/x", sessions: "1 session", age: "now" },
    ]);
    expect(view.recent?.more).toBeNull();
  });

  it("shows the first few, offers the rest, and all of them once asked", () => {
    const projects = Array.from({ length: WELCOME_RECENT_FIRST + 2 }, (_, i) => project(`/p${i}`, 1, NOW - i));
    const first = welcomeView({ projects, showAll: false, agents, now: NOW });
    expect(first.recent?.rows.map((row) => row.dir)).toEqual(projects.slice(0, WELCOME_RECENT_FIRST).map((p) => p.root));
    expect(first.recent?.more).toBe(WELCOME_WORDS.showAll);
    const all = welcomeView({ projects, showAll: true, agents, now: NOW });
    expect(all.recent?.rows).toHaveLength(projects.length);
    expect(all.recent?.more).toBeNull();
  });

  it("names the agents this machine has — or says it has none", () => {
    expect(welcomeView({ projects: [], showAll: false, agents, now: NOW }).agents).toEqual({ label: WELCOME_WORDS.agentsFound, names: ["claude", "kimi"] });
    expect(welcomeView({ projects: [], showAll: false, agents: [{ label: "codex", installed: false }], now: NOW }).agents).toEqual({ label: WELCOME_WORDS.noAgents, names: null });
  });

  it("names a project at the filesystem's root by its whole path", () => {
    expect(welcomeView({ projects: [project("/", 1, NOW)], showAll: false, agents, now: NOW }).recent?.rows[0].name).toBe("/");
  });
});
