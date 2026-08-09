// FIRST, before anything that reaches the mocked IPC — see testSupport.
import { HOST, resetCoreCommandTestState, setup, workspace } from "./testSupport";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandSource } from "../../domain/commands";
import type { StoredSkill } from "../../ipc/skills";

beforeEach(() => {
  resetCoreCommandTestState();
});

/** An agent calling from its own pane, in `wsId`. */
const paneIn = (wsId: string): CommandSource => ({
  kind: "external",
  client: "claude",
  pane: { id: "p1", workspaceId: wsId, label: "Claude 1" },
});

/** A client the user wired up by hand: no pane, so no workspace. */
const ANONYMOUS: CommandSource = { kind: "external", client: "some-editor" };

const row = (over: Partial<StoredSkill> = {}): StoredSkill => ({
  scope: "global",
  wsId: null,
  name: "review",
  content: "---\nname: review\ndescription: Reviews a diff\n---\nRead it.\n",
  ...over,
});

/** The two workspaces every scope case needs: ws-1 active, ws-2 not. */
const twoWorkspaces = () => [workspace({}), workspace({ id: "ws-2", name: "site" })];

describe("skills.list", () => {
  it("names each skill and what it is for, in the scope asked for", async () => {
    const { registry, skills } = setup([workspace({})]);
    vi.mocked(skills.list).mockResolvedValue([row()]);

    const result = await registry.execute("skills.list", { scope: "global" }, HOST);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([{ name: "review", description: "Reviews a diff" }]);
    }
    // Scoped at the library, not filtered here: one home for "which rows are
    // this library's".
    expect(skills.list).toHaveBeenCalledWith({ kind: "global" });
  });

  it("gives an agent its OWN workspace, not the one on screen", async () => {
    // ws-1 is active; the caller's pane lives in ws-2. Handing it the active
    // workspace would let an agent write into a library it cannot see.
    const { registry, skills } = setup(twoWorkspaces());

    await registry.execute("skills.list", { scope: "workspace" }, paneIn("ws-2"));

    expect(skills.list).toHaveBeenCalledWith({ kind: "workspace", wsId: "ws-2" });
  });

  it("gives a host caller the workspace the user is in", async () => {
    // Voice, a hotkey or a palette has no pane; "this workspace" can only mean
    // the active one.
    const { registry, skills } = setup(twoWorkspaces());

    await registry.execute("skills.list", { scope: "workspace" }, HOST);

    expect(skills.list).toHaveBeenCalledWith({ kind: "workspace", wsId: "ws-1" });
  });

  it("refuses a workspace scope for a client with no pane, and says what to use", async () => {
    const { registry, skills } = setup([workspace({})]);

    const result = await registry.execute("skills.list", { scope: "workspace" }, ANONYMOUS);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('scope "global"');
    expect(skills.list).not.toHaveBeenCalled();
  });

  it("refuses a scope that is neither library", async () => {
    // The registry validates the TYPE; only the handler knows the two values.
    const { registry, skills } = setup([workspace({})]);

    const result = await registry.execute("skills.list", { scope: "everywhere" }, HOST);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('"global" or "workspace"');
    expect(skills.list).not.toHaveBeenCalled();
  });

  it("refuses a call with no scope at all — the registry's own guard", async () => {
    const { registry } = setup([workspace({})]);

    const result = await registry.execute("skills.list", {}, HOST);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid-args");
  });
});

describe("skills.read", () => {
  it("answers the name, the description and the body", async () => {
    const { registry, skills } = setup([workspace({})]);
    vi.mocked(skills.read).mockResolvedValue({
      name: "review",
      description: "Reviews a diff",
      body: "Read it.\n",
      extraFrontmatter: ["license: MIT"],
    });

    const result = await registry.execute(
      "skills.read",
      { scope: "global", name: "review" },
      HOST,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Hand-added frontmatter stays out: a caller cannot set it here, and an
      // update keeps whatever the file has.
      expect(result.value).toEqual({
        name: "review",
        description: "Reviews a diff",
        body: "Read it.\n",
      });
    }
  });

  it("refuses a skill that scope does not hold, naming the scope", async () => {
    const { registry, skills } = setup(twoWorkspaces());
    vi.mocked(skills.read).mockResolvedValue(null);

    const result = await registry.execute(
      "skills.read",
      { scope: "workspace", name: "missing" },
      paneIn("ws-2"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('"missing"');
      expect(result.error.message).toContain("ws-2");
    }
  });
});

describe("skills.create", () => {
  it("writes the draft it was given", async () => {
    const { registry, skills } = setup([workspace({})]);

    const result = await registry.execute(
      "skills.create",
      {
        scope: "workspace",
        name: "deploy",
        description: "Ships the app",
        body: "Run the script.\n",
      },
      paneIn("ws-1"),
    );

    expect(result.ok).toBe(true);
    expect(skills.create).toHaveBeenCalledWith(
      { kind: "workspace", wsId: "ws-1" },
      {
        name: "deploy",
        description: "Ships the app",
        body: "Run the script.\n",
        extraFrontmatter: [],
      },
    );
  });

  it("reports the library's refusal verbatim", async () => {
    // Validation belongs to the library; this only has to not swallow it.
    const { registry, skills } = setup([workspace({})]);
    vi.mocked(skills.create).mockRejectedValueOnce(
      new Error('"Deploy It" is not a valid skill name'),
    );

    const result = await registry.execute(
      "skills.create",
      { scope: "global", name: "Deploy It", description: "d", body: "b" },
      HOST,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("not a valid skill name");
  });
});

describe("skills.update", () => {
  it("keeps the stored file's hand-added frontmatter", async () => {
    // A caller sends a name, a description and a body — it has no way to send
    // `allowed-tools` back, so dropping it would eat the user's own edit.
    const { registry, skills } = setup([workspace({})]);
    vi.mocked(skills.read).mockResolvedValue({
      name: "review",
      description: "Old",
      body: "Old body\n",
      extraFrontmatter: ["allowed-tools: Read"],
    });

    const result = await registry.execute(
      "skills.update",
      { scope: "global", name: "review", description: "New", body: "New body\n" },
      HOST,
    );

    expect(result.ok).toBe(true);
    expect(skills.update).toHaveBeenCalledWith(
      { kind: "global" },
      {
        name: "review",
        description: "New",
        body: "New body\n",
        extraFrontmatter: ["allowed-tools: Read"],
      },
    );
  });

  it("refuses a skill that does not exist instead of creating one", async () => {
    // The write underneath is a write: without the read first, an update would
    // quietly add a skill nobody asked to create.
    const { registry, skills } = setup([workspace({})]);
    vi.mocked(skills.read).mockResolvedValue(null);

    const result = await registry.execute(
      "skills.update",
      { scope: "global", name: "ghost", description: "d", body: "b" },
      HOST,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("skills.create");
    expect(skills.update).not.toHaveBeenCalled();
  });
});

describe("skills.rename and skills.delete", () => {
  const found = {
    name: "review",
    description: "d",
    body: "",
    extraFrontmatter: [],
  };

  it("renames an existing skill", async () => {
    const { registry, skills } = setup([workspace({})]);
    vi.mocked(skills.read).mockResolvedValue(found);

    const result = await registry.execute(
      "skills.rename",
      { scope: "global", from: "review", to: "deep-review" },
      HOST,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ name: "deep-review" });
    expect(skills.rename).toHaveBeenCalledWith({ kind: "global" }, "review", "deep-review");
  });

  it("refuses to rename what is not there", async () => {
    const { registry, skills } = setup([workspace({})]);
    vi.mocked(skills.read).mockResolvedValue(null);

    const result = await registry.execute(
      "skills.rename",
      { scope: "global", from: "ghost", to: "deep-review" },
      HOST,
    );

    expect(result.ok).toBe(false);
    expect(skills.rename).not.toHaveBeenCalled();
  });

  it("deletes an existing skill", async () => {
    const { registry, skills } = setup([workspace({})]);
    vi.mocked(skills.read).mockResolvedValue(found);

    const result = await registry.execute(
      "skills.delete",
      { scope: "global", name: "review" },
      HOST,
    );

    expect(result.ok).toBe(true);
    expect(skills.remove).toHaveBeenCalledWith({ kind: "global" }, "review");
  });

  it("refuses to delete what is not there", async () => {
    // Otherwise a typo answers "done" and the caller believes a skill is gone.
    const { registry, skills } = setup([workspace({})]);
    vi.mocked(skills.read).mockResolvedValue(null);

    const result = await registry.execute(
      "skills.delete",
      { scope: "global", name: "ghost" },
      HOST,
    );

    expect(result.ok).toBe(false);
    expect(skills.remove).not.toHaveBeenCalled();
  });
});
