// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentInfo } from "../../domain/agents";
import type { SessionRecord } from "../../domain/journal";
import { WorkspaceHistory } from "./WorkspaceHistory";

const worktreeIpc = vi.hoisted(() => ({
  probeWorktree: vi.fn((_path: string) =>
    Promise.resolve({ exists: true, isWorktree: false, branch: null }),
  ),
}));
vi.mock("../../ipc/worktree", () => worktreeIpc);

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
    worktreeIpc.probeWorktree.mockClear();
    worktreeIpc.probeWorktree.mockImplementation(() =>
      Promise.resolve({ exists: true, isWorktree: false, branch: null }),
    );
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });
  afterEach(() => act(() => root.unmount()));

  const render = (
    rows: SessionRecord[],
    onDelete = vi.fn(),
    onResume = vi.fn(),
    onFork = vi.fn(),
  ) => {
    act(() =>
      root.render(
        createElement(WorkspaceHistory, {
          rows,
          agents,
          onDelete,
          onResume,
          onFork,
        }),
      ),
    );
    return { onDelete, onResume, onFork };
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

  it("Resume passes the whole record; a live row offers no Resume", () => {
    const { onResume } = render([
      closed({ title: "auth bug" }),
      {
        agent: "claude",
        sessionId: "s-live",
        cwd: "/repo",
        boundAt: "2026-07-19T10:00:00.000Z",
        state: "live",
        paneId: "pane-1",
      },
    ]);
    const buttons = host.querySelectorAll<HTMLButtonElement>(".history__resume");
    expect(buttons).toHaveLength(1); // the live row has none
    act(() => buttons[0].click());
    expect(onResume).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: "s-1", state: "closed" }),
    );
  });

  it("a gone directory shows the badge and disables Resume", async () => {
    worktreeIpc.probeWorktree.mockImplementation((path: string) =>
      Promise.resolve({ exists: path !== "/gone", isWorktree: false, branch: null }),
    );
    render([closed({ cwd: "/gone" }), closed({ sessionId: "s-2" })]);
    await act(async () => {});

    const rows = host.querySelectorAll(".history__row");
    expect(rows[0].querySelector(".history__missing")).not.toBeNull();
    expect(
      rows[0].querySelector<HTMLButtonElement>(".history__resume")?.disabled,
    ).toBe(true);
    expect(rows[1].querySelector(".history__missing")).toBeNull();
    expect(
      rows[1].querySelector<HTMLButtonElement>(".history__resume")?.disabled,
    ).toBe(false);
  });

  it("Fork is offered on every row — a gone dir is exactly what forking rescues", async () => {
    worktreeIpc.probeWorktree.mockImplementation(() =>
      Promise.resolve({ exists: false, isWorktree: false, branch: null }),
    );
    const { onFork } = render([closed({ cwd: "/gone" })]);
    await act(async () => {});
    const fork = host.querySelector<HTMLButtonElement>(".history__fork")!;
    expect(fork.disabled).toBe(false);
    act(() => fork.click());
    expect(onFork).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: "s-1" }),
    );
  });

  it("the × forgets exactly that session", () => {
    const { onDelete } = render([closed(), closed({ sessionId: "s-2" })]);
    const buttons = host.querySelectorAll<HTMLButtonElement>(".history__delete");
    act(() => buttons[1].click());
    expect(onDelete).toHaveBeenCalledExactlyOnceWith("s-2");
  });
});

