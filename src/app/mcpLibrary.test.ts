import { describe, expect, it, vi } from "vitest";

vi.mock("../ipc/log", () => ({
  log: { warn: vi.fn() },
  describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import { composeMcpServerFile, type McpScope, type McpServerDraft } from "../domain/mcp";
import { log } from "../ipc/log";
import {
  createMcpLibrary,
  type LibraryMcpServer,
  type McpLibrary,
  type McpStorage,
} from "./mcpLibrary";

const GLOBAL: McpScope = { kind: "global" };
const WS: McpScope = { kind: "workspace", wsId: "ws-1" };

const row = (scope: McpScope, name: string, content: string): LibraryMcpServer => ({
  scope,
  name,
  content,
});

const github = (token: string): McpServerDraft => ({
  name: "github",
  body: {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: token },
  },
});

/** The library as the backend sees it: a global and a workspace `github`, so
 * a scope mix-up cannot pass unnoticed, plus a global-only server and one
 * file no codec can read. */
const STORED: LibraryMcpServer[] = [
  row(GLOBAL, "github", composeMcpServerFile(github("ghp_global").body)),
  row(GLOBAL, "fs", composeMcpServerFile({ transport: "stdio", command: "mcp-fs", args: [], env: {} })),
  row(GLOBAL, "broken", '{"transport":"sse"}'),
  row(WS, "github", composeMcpServerFile(github("ghp_ws").body)),
];

function libraryOver(over: Partial<McpStorage> = {}, reserved: string[] = ["keepdeck"]) {
  const storage = {
    fetch: vi.fn<McpStorage["fetch"]>(async () => STORED),
    save: vi.fn<McpStorage["save"]>(async () => {}),
    rename: vi.fn<McpStorage["rename"]>(async () => {}),
    remove: vi.fn<McpStorage["remove"]>(async () => {}),
    forgetWorkspace: vi.fn<McpStorage["forgetWorkspace"]>(async () => {}),
  };
  // Assigned rather than spread, so the mocks keep their `.mock` typing.
  Object.assign(storage, over);
  const library: McpLibrary = createMcpLibrary({ storage, reserved });
  return { library, storage };
}

describe("listing and reading", () => {
  it("lists one scope's rows, each already judged", async () => {
    const { library } = libraryOver();
    const rows = await library.list(GLOBAL);
    expect(rows.map((r) => [r.name, r.verdict.kind])).toEqual([
      ["github", "ok"],
      ["fs", "ok"],
      ["broken", "malformed"],
    ]);
    expect(await library.list(WS)).toHaveLength(1);
    expect(await library.list()).toHaveLength(4);
  });

  it("reads the draft from the scope asked, not a same-named twin", async () => {
    const { library } = libraryOver();
    const draft = await library.read(WS, "github");
    expect(draft.body).toMatchObject({ env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_ws" } });
  });

  it("refuses to read what is not there, or what it cannot parse", async () => {
    const { library } = libraryOver();
    await expect(library.read(WS, "fs")).rejects.toThrow('No server "fs" in this workspace');
    await expect(library.read(GLOBAL, "broken")).rejects.toThrow(
      /cannot be edited here — "transport" must be/,
    );
  });

  it("throws rather than lie when the backend cannot be read", async () => {
    const { library } = libraryOver({ fetch: async () => Promise.reject(new Error("disk")) });
    await expect(library.list()).rejects.toThrow("disk");
  });
});

describe("authoring", () => {
  it("creates by composing the file and telling the storage it is NEW", async () => {
    const { library, storage } = libraryOver();
    await library.create(GLOBAL, { ...github("ghp"), name: "gh2" });
    const [scope, name, content, expectNew] = storage.save.mock.calls[0]!;
    expect(scope).toEqual(GLOBAL);
    expect(name).toBe("gh2");
    expect(JSON.parse(content)).toMatchObject({ transport: "stdio", command: "npx" });
    expect(expectNew).toBe(true);
  });

  it("refuses a name a client could not carry, and says the rule", async () => {
    const { library, storage } = libraryOver();
    await expect(library.create(GLOBAL, { ...github("x"), name: "my.server" })).rejects.toThrow(
      /not a valid server name — letters, digits/,
    );
    await expect(library.create(GLOBAL, { ...github("x"), name: " " })).rejects.toThrow(
      "needs a name",
    );
    expect(storage.save).not.toHaveBeenCalled();
  });

  it("refuses a name the bundled tier holds — for a create and a rename", async () => {
    // The injection files bundled servers first and lets the first claim
    // win, so a library `keepdeck` would silently never reach a pane.
    const { library, storage } = libraryOver();
    await expect(library.create(GLOBAL, { ...github("x"), name: "keepdeck" })).rejects.toThrow(
      /KeepDeck ships with/,
    );
    await expect(library.rename(GLOBAL, "fs", "keepdeck")).rejects.toThrow(/KeepDeck ships with/);
    expect(storage.save).not.toHaveBeenCalled();
    expect(storage.rename).not.toHaveBeenCalled();
  });

  it("refuses a body the codec could not carry, before any byte moves", async () => {
    const { library, storage } = libraryOver();
    await expect(
      library.create(GLOBAL, {
        name: "x",
        body: { transport: "stdio", command: "  ", args: [], env: {} },
      }),
    ).rejects.toThrow("needs a command");
    await expect(
      library.create(GLOBAL, { name: "y", body: { transport: "http", url: "", headers: {} } }),
    ).rejects.toThrow("needs a URL");
    await expect(
      library.create(GLOBAL, {
        name: "z",
        body: { transport: "http", url: "https://x/", headers: { Authorization: "Basic a" }, bearerToken: "t" },
      }),
    ).rejects.toThrow("one credential");
    expect(storage.save).not.toHaveBeenCalled();
  });

  it("updates only what exists, in the scope named", async () => {
    const { library, storage } = libraryOver();
    await library.update(WS, github("ghp_new"));
    expect(storage.save).toHaveBeenLastCalledWith(WS, "github", expect.any(String), false);
    await expect(library.update(WS, { ...github("x"), name: "fs" })).rejects.toThrow('No server "fs"');
  });

  it("renames by moving, refusing a collision it can see", async () => {
    const { library, storage } = libraryOver();
    await library.rename(GLOBAL, "fs", "files");
    expect(storage.rename).toHaveBeenCalledWith(GLOBAL, "fs", "files");
    await expect(library.rename(GLOBAL, "fs", "github")).rejects.toThrow("already taken");
    await expect(library.rename(GLOBAL, "nope", "x")).rejects.toThrow('No server "nope"');
  });

  it("removes only what exists — the storage would call a miss a success", async () => {
    const { library, storage } = libraryOver();
    await library.remove(GLOBAL, "fs");
    expect(storage.remove).toHaveBeenCalledWith(GLOBAL, "fs");
    await expect(library.remove(WS, "fs")).rejects.toThrow('No server "fs"');
  });

  it("forgets a closing workspace's scope through the storage, and says the library changed", async () => {
    // A workspace id is a reused slot; the next workspace with it must not
    // inherit this one's servers and tokens.
    const { library, storage } = libraryOver();
    const listener = vi.fn();
    library.subscribe(listener);
    await library.forgetWorkspace("ws-1");
    expect(storage.forgetWorkspace).toHaveBeenCalledWith("ws-1");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("tells its subscribers after every write, a failed one included", async () => {
    const { library, storage } = libraryOver({
      remove: async () => Promise.reject(new Error("locked")),
    });
    const listener = vi.fn();
    library.subscribe(listener);
    await library.create(GLOBAL, { ...github("x"), name: "gh2" });
    await library.update(WS, github("y"));
    await library.rename(GLOBAL, "fs", "files");
    await expect(library.remove(GLOBAL, "fs")).rejects.toThrow("locked");
    expect(listener).toHaveBeenCalledTimes(4);
    expect(storage.save).toHaveBeenCalledTimes(2);
  });
});

describe("what a workspace gets", () => {
  it("resolves global then workspace, a workspace entry replacing a global twin", async () => {
    const { library } = libraryOver();
    const servers = await library.serversFor("ws-1");
    expect(servers.map((s) => s.spec.name)).toEqual(["github", "fs"]);
    // The workspace's `github` won: its token is the one in the environment.
    expect(servers[0]!.env).toEqual([["GITHUB_PERSONAL_ACCESS_TOKEN", "ghp_ws"]]);
  });

  it("hands another workspace the global set alone", async () => {
    const { library } = libraryOver();
    const servers = await library.serversFor("ws-9");
    expect(servers[0]!.env).toEqual([["GITHUB_PERSONAL_ACCESS_TOKEN", "ghp_global"]]);
  });

  it("skips a file it cannot read, with a warning, and serves the rest", async () => {
    const { library } = libraryOver();
    const servers = await library.serversFor("ws-1");
    expect(servers.map((s) => s.spec.name)).not.toContain("broken");
    expect(log.warn).toHaveBeenCalledWith(
      "web:mcp",
      expect.stringContaining('"broken" not injected'),
    );
  });

  it("a broken workspace twin does not cost the pane the global server it meant to replace", async () => {
    // Judged BEFORE the merge: merged first and skipped after, the malformed
    // workspace `fs` would have displaced the global one and then vanished,
    // leaving the pane with neither.
    const { library } = libraryOver({
      fetch: async () => [
        row(GLOBAL, "fs", composeMcpServerFile({ transport: "stdio", command: "mcp-fs", args: [], env: {} })),
        row(WS, "fs", "{not json"),
      ],
    });
    const servers = await library.serversFor("ws-1");
    expect(servers.map((s) => s.spec)).toEqual([
      { name: "fs", transport: "stdio", command: "mcp-fs", args: [] },
    ]);
    expect(log.warn).toHaveBeenCalledWith("web:mcp", expect.stringContaining('"fs" not injected'));
  });

  it("warns when two servers fight over one variable", async () => {
    const { library } = libraryOver({
      fetch: async () => [
        row(GLOBAL, "a", composeMcpServerFile({ transport: "stdio", command: "a", args: [], env: { TOKEN: "1" } })),
        row(GLOBAL, "b", composeMcpServerFile({ transport: "stdio", command: "b", args: [], env: { TOKEN: "2" } })),
      ],
    });
    await library.serversFor("ws-1");
    expect(log.warn).toHaveBeenCalledWith("web:mcp", expect.stringContaining('"a" and "b" both set TOKEN'));
  });
});
