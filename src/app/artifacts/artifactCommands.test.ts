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
    location: { kind: "attached", cwd: "/repo" },
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
    changed: () => {},
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

  it("rung 3: a resolved pane with a cwd publishes through the IPC with the workspace as host fact", async () => {
    const { run } = setup([pane()]);
    const result = await run(
      "artifact.publish",
      { title: "Auth Flow", format: "html", content: "<p/>", id: "auth-flow" },
      paneSource(),
    );
    expect(artifactPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        cwd: "/repo",
        slug: "auth-flow",
      }),
    );
    expect(result).toMatchObject({
      id: "auth-flow",
      version: 1,
      url: "http://127.0.0.1:43119/a/t/auth-flow",
    });
    // `isNew` is OFF the agent wire (the design's drop-it rule) — the
    // negative assertion is the pin (it once shipped ON, test-locked).
    expect(result).not.toHaveProperty("isNew");
    // No token anywhere in the wire result — and no author: who
    // published is not recorded.
    expect(JSON.stringify(result)).not.toContain('"token"');
    const sent = vi.mocked(artifactPublish).mock.calls[0][0];
    expect(Object.keys(sent)).not.toContain("label");
    expect(Object.keys(sent)).not.toContain("paneId");
  });

  it("rung 2: a provisioning pane with no cwd keeps content and refuses path with the remedy", async () => {
    // paneExecutionCwd answers null ONLY for a provisioning pane without
    // its own cwd (everything else falls back to ws.cwd) — that is the
    // rung-2 population.
    const provisioning: Workspace["panes"][number] = {
      ...pane({ id: "pane-bare" }),
      location: {
        kind: "provisioning",
        card: { repo: "/repo", path: "/repo/wt", workspace: "ws", index: 1 },
      },
    };
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
      { title: "T", format: "html", content: "<p>hi</p>" },
      paneSource(),
    )) as { note: string };
    expect(result.note).toContain("display server is off");
  });

  it("a format that is not html is refused before the invoke — md included", async () => {
    const { run } = setup([pane()]);
    await expect(
      run(
        "artifact.publish",
        { title: "T", format: "pdf", content: "x" },
        paneSource(),
      ),
    ).rejects.toThrow(/unknown format.*pdf/);
    expect(artifactPublish).not.toHaveBeenCalled();

    // THE REMOVAL'S OWN PIN: md is refused at the same door, by the same
    // rule, with no special sentence — it is a word that is not html.
    await expect(
      run(
        "artifact.publish",
        { title: "T", format: "md", content: "# hi" },
        paneSource(),
      ),
    ).rejects.toThrow(/unknown format.*md.*html pages/);
    expect(artifactPublish).not.toHaveBeenCalled();
  });

  it("read parses a numeric version and rejects junk by NAME", async () => {
    vi.mocked(artifactRead).mockResolvedValue({
      kind: "inline",
      id: "x",
      version: 3,
      title: "T",
      format: "html",
      content: "x",
      at: 1,
    });
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
    const remotePane: Workspace["panes"][number] = {
      ...pane({ id: "pane-remote" }),
      location: { kind: "remote", endpoint: "ssh://host" },
    };
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
    ).rejects.toThrow(/title must be 1\.\.200 chars/);
  });

  it("a message of 300 emoji (900 UTF-16 units, 300 scalars) passes the cap the domain judges", async () => {
    // The A5 pin: the command layer once re-implemented the rule with
    // `.length` (UTF-16 units) while the domain home counts SCALARS —
    // a 251-500 emoji message was refused here and accepted by both
    // real homes. The verdict is the domain's; this pin holds the
    // command layer to it.
    const { run } = setup([pane()]);
    await run(
      "artifact.publish",
      { title: "T", format: "html", content: "x", message: "🚀".repeat(300) },
      paneSource(),
    );
    expect(artifactPublish).toHaveBeenCalled();
    // And the true over-cap, also in scalars: 501 emoji refuse.
    await expect(
      run(
        "artifact.publish",
        { title: "T", format: "html", content: "x", message: "🚀".repeat(501) },
        paneSource(),
      ),
    ).rejects.toThrow(/message must be ≤500 chars/);
  });

  it("delete passes the workspace-scoped slug through", async () => {
    vi.mocked(artifactDelete).mockResolvedValue({
      id: "x",
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

  it("announce fires on isNew, NEVER on republish, and on delete — changed fires on every landed write", async () => {
    // The two signals answer different questions: announce is about the
    // user's attention, changed is about what a surface is showing. A
    // republish is precisely where they must disagree.
    const announce = vi.fn();
    const changed = vi.fn();
    const deck = () => ({ workspaces: [ws([pane()])] });
    const registry = createCommandRegistry();
    registerArtifactCommands(registry, {
      deck,
      announce,
      changed,
    });
    const run = async (id: string, args: Record<string, unknown>, source: CommandSource) => {
      const result = await registry.execute(id, args as never, source);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    };

    // First publish: isNew → announce("published").
    await run("artifact.publish", { title: "T", format: "html", content: "x" }, paneSource());
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "published", slug: "auth-flow" }),
    );
    expect(changed).toHaveBeenCalledTimes(1);

    // Republish (isNew false in the IPC result): NO announce.
    vi.mocked(artifactPublish).mockResolvedValue({
      slug: "auth-flow", version: 2, isNew: false,
      url: "http://x/a/t/auth-flow", indexUrl: "http://x/i/",
    });
    await run("artifact.publish", { title: "T", format: "html", content: "y" }, paneSource());
    expect(announce).toHaveBeenCalledTimes(1);
    // …but the list DID change: a new version, a new stamp, a new author.
    expect(changed).toHaveBeenCalledTimes(2);

    // Delete (deleted true): announce("deleted").
    vi.mocked(artifactDelete).mockResolvedValue({ id: "auth-flow", deleted: true, versionCount: 2, createdAt: 1 });
    await run("artifact.delete", { id: "auth-flow" }, paneSource());
    expect(announce).toHaveBeenCalledTimes(2);
    expect(announce).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "deleted", slug: "auth-flow" }),
    );
    expect(changed).toHaveBeenCalledTimes(3);

    // Idempotent no-op delete (deleted false): NO announce.
    vi.mocked(artifactDelete).mockResolvedValue({ id: "auth-flow", deleted: false, versionCount: null, createdAt: null });
    await run("artifact.delete", { id: "auth-flow" }, paneSource());
    expect(announce).toHaveBeenCalledTimes(2);
    // Nothing was removed, so nothing on screen went stale either.
    expect(changed).toHaveBeenCalledTimes(3);
  });
});
