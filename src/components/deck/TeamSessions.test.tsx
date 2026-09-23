// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionHandle } from "../../domain/journal";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import { roleById } from "../../domain/mail";
import { ROLE_WORDS } from "../../presentation/roleChoiceView";
import { TEAM_SESSIONS_WORDS } from "../../presentation/stageView";

/** The browser under the list, as the list drives it: what it scopes and
 * what a row's Resume and Fork call. Its own suite covers the rows. */
const browser = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));
vi.mock("../history/SessionsBrowser", () => ({
  WorkspaceSessionsBrowser: (props: Record<string, unknown>) => {
    browser.props = props;
    return null;
  },
}));

/** The live catalog as the list reads it: a new snapshot per install. */
const liveCatalog = vi.hoisted(() => ({ snapshot: {} as object }));
vi.mock("../../app/useRoleCatalog", () => ({ useRoleCatalog: () => liveCatalog.snapshot }));

import { TeamSessions } from "./TeamSessions";
import { configureRoleCatalog, teamRoles } from "../../domain/mail";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const record = { agent: "claude", sessionId: "s-1", cwd: "/repo/wt" } as SessionHandle;

describe("TeamSessions — an empty team's sessions list", () => {
  let root: Root;
  const onContinue = vi.fn();

  const render = () =>
    act(() =>
      root.render(
        createElement(TeamSessions, {
          ws: {
            id: "ws-1",
            instance: createWorkspaceInstance(),
            name: "ws",
            cwd: "/repo",
            worktreeBaseDir: null,
            panes: [],
          },
          cwd: "/repo/wt",
          journal: {},
          browserShared: {} as never,
          agents: [],
          agentsReady: true,
          onContinue,
        }),
      ),
    );

  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    onContinue.mockClear();
    render();
  });

  afterEach(() => {
    act(() => root.unmount());
    configureRoleCatalog(null);
  });

  const picker = () => document.querySelector<HTMLButtonElement>(".team-sessions__role .dropdown__button")!;
  const options = () => {
    act(() => picker().click());
    const found = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    return found;
  };
  const pick = (label: string) => {
    const option = options().find((button) => button.textContent === label)!;
    act(() => option.click());
  };
  const hint = () => document.querySelector(".team-sessions__hint")!;
  const resume = (r: SessionHandle) => act(() => (browser.props!.onResume as (r: SessionHandle) => void)(r));
  const fork = (r: SessionHandle) => act(() => (browser.props!.onFork as (r: SessionHandle) => void)(r));

  it("scopes the list to the team's directory and asks the rows about THIS team", () => {
    expect([...(browser.props!.dirs as Set<string>)]).toEqual(["/repo/wt"]);
    expect(browser.props!.team).toEqual({ cwd: "/repo/wt" });
    expect(document.body.textContent).toContain(TEAM_SESSIONS_WORDS.title);
  });

  it("offers a lead or a peer, and picks neither", () => {
    expect(picker().textContent).toContain(ROLE_WORDS.prompt);
    const labels = options().map((button) => button.textContent);
    expect(labels).toEqual([ROLE_WORDS.prompt, roleById("lead")!.label, roleById("peer")!.label]);
  });

  it("continues nothing until a role is picked — and says so where the role is", () => {
    resume(record);
    fork(record);
    expect(onContinue).not.toHaveBeenCalled();
    expect(hint().textContent).toBe(TEAM_SESSIONS_WORDS.pickFirst);
    expect(hint().className).toContain("team-sessions__hint--error");
  });

  it("continues under the address the pick takes, resumed or forked", () => {
    pick(roleById("peer")!.label);
    expect(hint().textContent).toContain("peer-1");
    resume(record);
    fork(record);
    expect(onContinue.mock.calls).toEqual([
      ["resume", record, "peer-1"],
      ["fork", record, "peer-1"],
    ]);
  });

  it("follows the live catalog: a picked role the catalog drops is no pick any more", () => {
    const peerLabel = roleById("peer")!.label;
    pick(peerLabel);
    configureRoleCatalog(teamRoles().filter((role) => role.id !== "peer"));
    liveCatalog.snapshot = {};
    render();
    expect(picker().textContent).toContain(ROLE_WORDS.prompt);
    expect(options().map((button) => button.textContent)).not.toContain(peerLabel);
    resume(record);
    expect(onContinue).not.toHaveBeenCalled();
  });
});
