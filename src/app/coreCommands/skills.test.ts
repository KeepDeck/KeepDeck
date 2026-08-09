// FIRST, before anything that reaches the mocked IPC — see testSupport.
import {
  HOST,
  resetCoreCommandTestState,
  setup,
  twoWorkspaces,
  workspace,
} from "./testSupport";
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

  it("refuses a host caller's workspace scope when no workspace is open", async () => {
    // `activeId` is a plain string whose "none" is `""`, so a null check was
    // dead code and the scope silently became `{wsId: ""}` — a library that
    // exists nowhere, answered with a cheerful empty list.
    const { registry, skills } = setup([]);

    const result = await registry.execute("skills.list", { scope: "workspace" }, HOST);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('scope "global"');
    expect(skills.list).not.toHaveBeenCalled();
  });

  it("refuses a host caller's workspace scope when the active id names nothing", async () => {
    // The id can also outlive the workspace it names, which an id-only check
    // would still let through.
    const { registry, deck, skills } = setup([workspace({ id: "ws-1" })]);
    deck.activeId = "ws-gone";

    const result = await registry.execute("skills.list", { scope: "workspace" }, HOST);

    expect(result.ok).toBe(false);
    expect(skills.list).not.toHaveBeenCalled();
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

  it("passes the library's own absence refusal through", async () => {
    // The handler decides NOTHING about absence: `read` refuses, in the same
    // words every mutation uses, and this door only carries the sentence out.
    // It used to word its own, and the two had already drifted apart.
    const { registry, skills } = setup(twoWorkspaces());
    vi.mocked(skills.read).mockRejectedValue(
      new Error(`No skill "missing" in this workspace's library`),
    );

    const result = await registry.execute(
      "skills.read",
      { scope: "workspace", name: "missing" },
      paneIn("ws-2"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe(`No skill "missing" in this workspace's library`);
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
  it("hands the caller's fields to the library and nothing else", async () => {
    // It does NOT read first: the library refuses an update of a skill that is
    // not there, and carries the stored file's other frontmatter over itself —
    // so both doors behave the same and neither can forget the step.
    const { registry, skills } = setup([workspace({})]);

    const result = await registry.execute(
      "skills.update",
      { scope: "global", name: "review", description: "New", body: "New body\n" },
      HOST,
    );

    expect(result.ok).toBe(true);
    expect(skills.read).not.toHaveBeenCalled();
    expect(skills.update).toHaveBeenCalledWith(
      { kind: "global" },
      {
        name: "review",
        description: "New",
        body: "New body\n",
        extraFrontmatter: [],
      },
    );
  });

  it("reports the library's refusal for a skill that is not there", async () => {
    const { registry, skills } = setup([workspace({})]);
    vi.mocked(skills.update).mockRejectedValueOnce(
      new Error('No skill "ghost" in the global library'),
    );

    const result = await registry.execute(
      "skills.update",
      { scope: "global", name: "ghost", description: "d", body: "b" },
      HOST,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('No skill "ghost"');
  });
});

describe("skills.rename and skills.delete", () => {
  it("renames through the library, reporting the new name", async () => {
    const { registry, skills } = setup([workspace({})]);

    const result = await registry.execute(
      "skills.rename",
      { scope: "global", from: "review", to: "deep-review" },
      HOST,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ name: "deep-review" });
    expect(skills.rename).toHaveBeenCalledWith({ kind: "global" }, "review", "deep-review");
    expect(skills.read).not.toHaveBeenCalled();
  });

  it("deletes through the library", async () => {
    const { registry, skills } = setup([workspace({})]);

    const result = await registry.execute(
      "skills.delete",
      { scope: "global", name: "review" },
      HOST,
    );

    expect(result.ok).toBe(true);
    expect(skills.remove).toHaveBeenCalledWith({ kind: "global" }, "review");
    expect(skills.read).not.toHaveBeenCalled();
  });

  it("reports a refusal from either, rather than answering done", async () => {
    // The library owns "it has to be there"; these only must not swallow it.
    const { registry, skills } = setup([workspace({})]);
    vi.mocked(skills.rename).mockRejectedValueOnce(new Error('No skill "ghost"'));
    vi.mocked(skills.remove).mockRejectedValueOnce(new Error('No skill "ghost"'));

    const renamed = await registry.execute(
      "skills.rename",
      { scope: "global", from: "ghost", to: "shade" },
      HOST,
    );
    const deleted = await registry.execute(
      "skills.delete",
      { scope: "global", name: "ghost" },
      HOST,
    );

    expect(renamed.ok).toBe(false);
    expect(deleted.ok).toBe(false);
  });
});

describe("arguments are read the same way as everywhere else in the set", () => {
  it("trims, like every other core command's string argument", async () => {
    // `workspace.switch {workspace: "web "}` has always trimmed; this set began
    // with a bare String(), so one MCP surface trimmed some arguments and not
    // others.
    const { registry, skills } = setup([workspace({})]);

    const result = await registry.execute(
      "skills.create",
      { scope: " global ", name: " deploy ", description: " Ships it ", body: " Run it\n" },
      HOST,
    );

    expect(result.ok).toBe(true);
    expect(skills.create).toHaveBeenCalledWith(
      { kind: "global" },
      // The body is the exception, kept verbatim: it is content, and trimming
      // it would edit what the caller wrote.
      { name: "deploy", description: "Ships it", body: " Run it\n", extraFrontmatter: [] },
    );
  });

  it("refuses a blank required argument instead of passing it down", async () => {
    const { registry, skills } = setup([workspace({})]);

    const result = await registry.execute(
      "skills.delete",
      { scope: "global", name: "   " },
      HOST,
    );

    expect(result.ok).toBe(false);
    expect(skills.remove).not.toHaveBeenCalled();
  });
});
