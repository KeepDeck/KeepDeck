import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../domain/deck";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import type { CommandSource } from "../../domain/commands";
import { createCommandRegistry } from "../../domain/commands";
import { registerArtifactCommands } from "./artifactCommands";

vi.mock("../../ipc/artifacts", () => ({
  artifactPublish: vi.fn(),
  artifactList: vi.fn(),
  artifactRead: vi.fn(),
  artifactDelete: vi.fn(),
}));

import {
  artifactPublish,
  artifactList,
  artifactRead,
  artifactDelete,
} from "../../ipc/artifacts";

const ws = (panes: Workspace["panes"]): Workspace => ({
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "KeepDeck",
  cwd: "/repo",
  worktreeBaseDir: null,
  panes,
});

const pane = (over: Partial<Workspace["panes"][number]> = {}) =>
  ({
    id: "pane-1",
    title: "support 1",
    cwd: "/repo",
    ...over,
  }) as Workspace["panes"][number];

/** The external-with-pane source the MCP pump resolves. */
const paneSource = (id = "pane-1"): CommandSource =>
  ({
    kind: "external",
    client: "mcp",
    pane: { id, workspaceId: "ws-1", label: "support 1" },
  }) as CommandSource;

const anonymous: CommandSource = { kind: "external", client: "mcp" };

function setup(panes: Workspace["panes"]) {
  const registry = createCommandRegistry();
  const dispose = registerArtifactCommands(registry, {
    deck: () => ({ workspaces: [ws(panes)] }),
  });
  const run = async (
    id: string,
    args: Record<string, unknown>,
    source: CommandSource,
  ) => {
    const result = await registry.execute(
      id,
      args as never,
      source,
    );
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };
  return { registry, dispose, run };
}

describe("registerArtifactCommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(artifactPublish).mockResolvedValue({
      slug: "auth-flow",
      version: 1,
      isNew: true,
      url: "http://127.0.0.1:43119/a/t/auth-flow",
      indexUrl: "http://127.0.0.1:43119/i/",
    });
  });

  it("registers exactly the four tools with flat string args", () => {
    const { registry, dispose } = setup([pane()]);
    const ids = registry.list().map((c) => c.id).sort();
    expect(ids).toEqual([
      "artifact.delete",
      "artifact.list",
      "artifact.publish",
      "artifact.read",
    ]);
    for (const command of registry.list()) {
      for (const arg of command.args) {
        expect(arg.type).toBe("string");
      }
    }
    dispose();
    expect(registry.list()).toHaveLength(0);
  });

  it("rung 1: an anonymous caller is refused with the remedy, every tool", async () => {
    const { run } = setup([pane()]);
    for (const [id, args] of [
      ["artifact.publish", { title: "T", format: "html", content: "x" }],
      ["artifact.list", {}],
      ["artifact.read", { id: "x" }],
      ["artifact.delete", { id: "x" }],
    ] as const) {
      await expect(run(id, { ...args }, anonymous)).rejects.toThrow(
        /deck-internal.*KeepDeck-launched pane/s,
      );
    }
    expect(artifactPublish).not.toHaveBeenCalled();
  });

  it("a host source is equally refused (deck-internal tools)", async () => {
    const { run } = setup([pane()]);
    await expect(
      run("artifact.list", {}, { kind: "host" }),
    ).rejects.toThrow(/deck-internal/);
  });

  it("rung 3: a resolved pane with a cwd publishes through the IPC with identity as host fact", async () => {
    const { run } = setup([pane()]);
    const result = await run(
      "artifact.publish",
      { title: "Auth Flow", format: "html", content: "<p/>", id: "auth-flow" },
      paneSource(),
    );
    expect(artifactPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        paneId: "pane-1",
        label: "support 1",
        cwd: "/repo",
        slug: "auth-flow",
      }),
    );
    expect(result).toMatchObject({
      id: "auth-flow",
      version: 1,
      isNew: true,
      url: "http://127.0.0.1:43119/a/t/auth-flow",
    });
    // No token anywhere in the wire result.
    expect(JSON.stringify(result)).not.toContain('"token"');
  });

  it("rung 2: a provisioning pane with no cwd keeps content and refuses path with the remedy", async () => {
    // paneExecutionCwd answers null ONLY for a provisioning pane without
    // its own cwd (everything else falls back to ws.cwd) — that is the
    // rung-2 population.
    const provisioning = {
      ...pane({ id: "pane-bare" }),
      cwd: undefined,
      provisioning: true,
    } as unknown as Workspace["panes"][number];
    const { run } = setup([provisioning]);
    await expect(
      run(
        "artifact.publish",
        { title: "T", format: "html", path: "/repo/page.html" },
        paneSource("pane-bare"),
      ),
    ).rejects.toThrow(/path publish needs a pane cwd.*content.*instead/s);
    // And content still works, cwd:null riding the payload:
    await run(
      "artifact.publish",
      { title: "T", format: "html", content: "<p/>" },
      paneSource("pane-bare"),
    );
    expect(artifactPublish).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: null }),
    );
  });

  it("the wire result says the display-server-off truth when urls are null", async () => {
    vi.mocked(artifactPublish).mockResolvedValue({
      slug: "x",
      version: 1,
      isNew: true,
      url: null,
      indexUrl: null,
    });
    const { run } = setup([pane()]);
    const result = (await run(
      "artifact.publish",
      { title: "T", format: "md", content: "# hi" },
      paneSource(),
    )) as { note: string };
    expect(result.note).toContain("display server is off");
  });

  it("a format outside html|md is refused before the invoke", async () => {
    const { run } = setup([pane()]);
    await expect(
      run(
        "artifact.publish",
        { title: "T", format: "pdf", content: "x" },
        paneSource(),
      ),
    ).rejects.toThrow(/unknown format.*pdf/);
    expect(artifactPublish).not.toHaveBeenCalled();
  });

  it("read parses a numeric version and rejects junk by NAME", async () => {
    vi.mocked(artifactRead).mockResolvedValue({ kind: "inline", content: "x" });
    const { run } = setup([pane()]);
    await run("artifact.read", { id: "x", version: "3" }, paneSource());
    expect(artifactRead).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "x", version: 3 }),
    );
    await expect(
      run("artifact.read", { id: "x", version: "abc" }, paneSource()),
    ).rejects.toThrow(/version must be a number/);
    await run("artifact.read", { id: "x" }, paneSource());
    expect(artifactRead).toHaveBeenLastCalledWith(
      expect.objectContaining({ version: undefined }),
    );
  });

  it("a remote pane's path arm is refused BY NAME, content passes", async () => {
    const remotePane = {
      ...pane({ id: "pane-remote" }),
      remoteEndpoint: "ssh://host",
    } as unknown as Workspace["panes"][number];
    const { run } = setup([remotePane]);
    await expect(
      run(
        "artifact.publish",
        { title: "T", format: "html", path: "/repo/page.html" },
        paneSource("pane-remote"),
      ),
    ).rejects.toThrow(/runs remotely.*local-only.*content/s);
    await run(
      "artifact.publish",
      { title: "T", format: "html", content: "<p/>" },
      paneSource("pane-remote"),
    );
    expect(artifactPublish).toHaveBeenCalled();
  });

  it("an over-length title is refused before the invoke", async () => {
    const { run } = setup([pane()]);
    await expect(
      run(
        "artifact.publish",
        { title: "x".repeat(201), format: "html", content: "x" },
        paneSource(),
      ),
    ).rejects.toThrow(/title must be ≤200/);
    expect(artifactPublish).not.toHaveBeenCalled();
  });

  it("delete passes the workspace-scoped slug through", async () => {
    vi.mocked(artifactDelete).mockResolvedValue({
      slug: "x",
      deleted: true,
      versionCount: 2,
      createdAt: 1,
    });
    const { run } = setup([pane()]);
    await run("artifact.delete", { id: "x" }, paneSource());
    expect(artifactDelete).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      slug: "x",
    });
  });

  it("list carries the empty-workspace note", async () => {
    vi.mocked(artifactList).mockResolvedValue([]);
    const { run } = setup([pane()]);
    const result = (await run("artifact.list", {}, paneSource())) as {
      note: string;
    };
    expect(result.note).toContain("nothing published");
  });

  it("a pane the deck no longer holds is anonymous (no wrong-pane naming)", async () => {
    const { run } = setup([pane()]);
    await expect(
      run("artifact.list", {}, paneSource("pane-gone")),
    ).rejects.toThrow(/deck-internal/);
  });
});
