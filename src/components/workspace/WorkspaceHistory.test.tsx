// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentInfo } from "../../domain/agents";
import type { SessionRecord } from "../../domain/journal";
import { WorkspaceHistory } from "./WorkspaceHistory";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const agent = (id: string, label: string): AgentInfo => ({
  id,
  label,
  command: id,
  supportsYolo: false,
  installed: true,
  path: null,
});
const agents: AgentInfo[] = [agent("claude", "Claude Code"), agent("codex", "Codex")];

const closed = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  agent: "claude",
  sessionId: "s-1",
  cwd: "/repo",
  boundAt: "2026-07-19T10:00:00.000Z",
  state: "closed",
  endedAt: "2026-07-19T11:00:00.000Z",
  ...over,
} as SessionRecord);

describe("WorkspaceHistory", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });
  afterEach(() => act(() => root.unmount()));

  const render = (rows: SessionRecord[], onDelete = vi.fn()) => {
    act(() =>
      root.render(createElement(WorkspaceHistory, { rows, agents, onDelete })),
    );
    return onDelete;
  };

  it("empty journal shows the + Agent hint, not a list", () => {
    render([]);
    expect(host.textContent).toContain("No sessions yet");
    expect(host.textContent).toContain("+ Agent");
    expect(host.querySelector(".history__list")).toBeNull();
  });

  it("renders a row per record: frozen title, branch chip, closed state", () => {
    render([
      closed({ title: "auth bug", branch: "kd/ws/1" }),
      closed({ sessionId: "s-2", agent: "codex" }),
    ]);
    const rows = host.querySelectorAll(".history__row");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("auth bug");
    expect(rows[0].querySelector(".history__chip")?.textContent).toBe("kd/ws/1");
    expect(rows[0].querySelector(".history__state--live")).toBeNull();
    // No frozen title → the agent's label stands in.
    expect(rows[1].textContent).toContain("Codex");
    expect(rows[1].querySelector(".history__chip")).toBeNull();
  });

  it("a live record shows the running dot", () => {
    render([
      {
        agent: "claude",
        sessionId: "s-live",
        cwd: "/repo",
        boundAt: "2026-07-19T10:00:00.000Z",
        state: "live",
        paneId: "pane-1",
      },
    ]);
    expect(host.querySelector(".history__state--live")).not.toBeNull();
  });

  it("the × forgets exactly that session", () => {
    const onDelete = render([closed(), closed({ sessionId: "s-2" })]);
    const buttons = host.querySelectorAll<HTMLButtonElement>(".history__delete");
    act(() => buttons[1].click());
    expect(onDelete).toHaveBeenCalledExactlyOnceWith("s-2");
  });
});
