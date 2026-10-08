import { describe, expect, it } from "vitest";
import { WELCOME_RECENT_FIRST, WELCOME_ROW_ESTIMATE_PX, WELCOME_STEPS, WELCOME_WORDS, welcomeView } from "./welcomeView";

const DAY = 86_400_000;
const NOW = 100 * DAY;
const HOME = "/Users/me";
const project = (root: string, sessions: number, lastAt: number) => ({ root, sessions, lastAt });
const MARK = { viewBox: "0 0 24 24", paths: [{ d: "M0 0h24v24H0z" }] };
const agents = [
  { label: "claude", installed: true, icon: MARK },
  { label: "codex", installed: false },
  { label: "kimi", installed: true },
];
const view = (over: Partial<Parameters<typeof welcomeView>[0]> = {}) =>
  welcomeView({ projects: [], home: HOME, showAll: false, agents, now: NOW, ...over });

describe("what the welcome screen says", () => {
  it("greets a first run in one column, with the way in, its key and the steps — and no list where agents have worked nowhere", () => {
    const first = view();
    expect(first.title).toBe(WELCOME_WORDS.firstTitle);
    expect(first.className).toBe("welcome");
    expect(first.recent).toBeNull();
    expect([first.open, first.shortcut]).toEqual([WELCOME_WORDS.open, "⌘N"]);
    expect(first.steps).toBe(WELCOME_STEPS);
  });

  it("welcomes back, beside the list, once there is one project to come back to", () => {
    const back = view({ projects: [project(`${HOME}/x`, 1, NOW)] });
    expect(back.title).toBe(WELCOME_WORDS.backTitle);
    expect(back.className).toBe("welcome welcome--with-recent");
  });

  it("shows each project by its folder's name, the path under ~, its sessions and age", () => {
    const back = view({ projects: [project(`${HOME}/Projects/KeepDeck`, 76, NOW - 3 * DAY), project("/opt/x", 1, NOW)] });
    expect(back.recent?.rows).toEqual([
      { key: `${HOME}/Projects/KeepDeck`, dir: `${HOME}/Projects/KeepDeck`, name: "KeepDeck", path: "~/Projects/KeepDeck", sessions: "76 sessions", age: "3d ago" },
      { key: "/opt/x", dir: "/opt/x", name: "x", path: "/opt/x", sessions: "1 session", age: "now" },
    ]);
    expect(back.recent?.rowEstimate).toBe(WELCOME_ROW_ESTIMATE_PX);
    expect(back.recent?.more).toBeNull();
  });

  it("shows the first few, offers the rest, and all of them once asked", () => {
    const projects = Array.from({ length: WELCOME_RECENT_FIRST + 2 }, (_, i) => project(`/p${i}`, 1, NOW - i));
    const first = view({ projects });
    expect(first.recent?.rows.map((row) => row.dir)).toEqual(projects.slice(0, WELCOME_RECENT_FIRST).map((p) => p.root));
    expect(first.recent?.more).toBe(WELCOME_WORDS.showAll);
    const all = view({ projects, showAll: true });
    expect(all.recent?.rows).toHaveLength(projects.length);
    expect(all.recent?.more).toBeNull();
  });

  it("names every agent with its mark, the ones not found quiet — and says when none is found", () => {
    expect(view().agents).toEqual({
      label: WELCOME_WORDS.agentsFound,
      items: [
        { name: "claude", icon: MARK, className: "kd-tag kd-tag--outline welcome__agent" },
        { name: "codex", icon: null, className: "kd-tag kd-tag--outline welcome__agent welcome__agent--missing" },
        { name: "kimi", icon: null, className: "kd-tag kd-tag--outline welcome__agent" },
      ],
    });
    expect(view({ agents: [{ label: "kimi", installed: true }] }).agents.label).toBe(WELCOME_WORDS.agentsFound);
    expect(view({ agents: [{ label: "codex", installed: false }] }).agents.label).toBe(WELCOME_WORDS.noAgents);
  });

  it("names a project at the filesystem's root by its whole path", () => {
    expect(view({ projects: [project("/", 1, NOW)] }).recent?.rows[0].name).toBe("/");
  });
});
