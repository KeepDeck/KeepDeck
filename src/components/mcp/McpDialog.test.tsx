// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpLibraryRow } from "../../app/mcpLibrary";
import type { McpEditorState } from "../../app/useMcpLibrary";
import type { McpStatus } from "../../app/mcp";
import { sameMcpRef, type McpScope, type McpServerDraft } from "../../domain/mcp";
import { McpDialog } from "./McpDialog";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A row as the library would list it after the write landed. */
const landed = (scope: McpScope, draft: McpServerDraft): McpLibraryRow => ({
  scope,
  name: draft.name,
  verdict: { kind: "ok", body: draft.body },
});

// ANNOTATED, like the skills dialog's double: an added field on the state
// must fail to compile HERE rather than reach the component as undefined.
const lib = vi.hoisted(
  () =>
    ({
      servers: [] as McpLibraryRow[] | null,
      error: null as string | null,
      listTrusted: true as boolean,
      clearError: vi.fn(),
      // The writes LAND IN THE LIST, the way the real hook's re-read makes them.
      save: vi.fn(async (scope: McpScope, draft: McpServerDraft, mode: "create" | "update") => {
        lib.servers =
          mode === "create"
            ? [...(lib.servers ?? []), landed(scope, draft)]
            : (lib.servers ?? []).map((s) =>
                sameMcpRef(s, { scope, name: draft.name }) ? landed(scope, draft) : s,
              );
        return true;
      }),
      rename: vi.fn(async (scope: McpScope, from: string, to: string) => {
        lib.servers = (lib.servers ?? []).map((s) =>
          sameMcpRef(s, { scope, name: from }) ? { ...s, name: to } : s,
        );
        return true;
      }),
      remove: vi.fn(async (scope: McpScope, name: string) => {
        lib.servers = (lib.servers ?? []).filter((s) => !sameMcpRef(s, { scope, name }));
        return true;
      }),
    }) satisfies McpEditorState,
);
vi.mock("../../app/useMcpLibrary", () => ({ useMcpLibrary: () => lib }));

const statusState = vi.hoisted(() => ({
  current: {
    socket: "/home/mcp.sock",
    error: null,
    connect: { command: "/bin/keepdeck", args: ["--mcp-shim", "/home/mcp.sock"] },
    connectError: null,
    refused: [],
  } as McpStatus,
}));
vi.mock("../../app/mcp/useMcpStatus", () => ({ useMcpStatus: () => statusState.current }));

const server = (name: string, scope: McpScope = { kind: "global" }): McpLibraryRow => ({
  scope,
  name,
  verdict: {
    kind: "ok",
    body: { transport: "stdio", command: "npx", args: ["-y", name], env: { TOKEN: "t" } },
  },
});

const row = (name: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>(".library__item")).find(
    (b) => b.querySelector(".library__item-name")?.textContent === name,
  );
const button = (text: string) =>
  Array.from(document.querySelectorAll("button")).find((b) => b.textContent === text);
const buttonByTitle = (title: string) =>
  document.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
const input = (id: string) => document.querySelector<HTMLInputElement>(`#${id}`)!;
const textarea = (id: string) => document.querySelector<HTMLTextAreaElement>(`#${id}`)!;
const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};

let root: Root;
let host: HTMLDivElement;
const onClose = vi.fn();

const render = (activeWs: { id: string; name: string } | null = { id: "ws-1", name: "KeepDeck" }) =>
  act(() => root.render(createElement(McpDialog, { activeWs, onClose })));

beforeEach(() => {
  lib.servers = [];
  lib.error = null;
  lib.listTrusted = true;
  lib.save.mockClear();
  lib.remove.mockClear();
  onClose.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("McpDialog", () => {
  it("lists Global, the workspace and the Bundled tier, the tier without + New", () => {
    lib.servers = [server("github"), server("fs", { kind: "workspace", wsId: "ws-1" })];
    render();
    const labels = Array.from(document.querySelectorAll(".library__group-label")).map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(["Global", "KeepDeck", "Bundled"]);
    expect(row("github")).toBeDefined();
    expect(row("fs")).toBeDefined();
    expect(row("keepdeck")).toBeDefined();
    expect(buttonByTitle("New global server")).not.toBeNull();
    expect(buttonByTitle("New workspace server")).not.toBeNull();
    expect(document.querySelectorAll(".library__new")).toHaveLength(2);
  });

  it("opens the deck's own server read-only, showing its invocation", () => {
    render();
    act(() => row("keepdeck")!.click());
    expect(input("mcp-command").value).toBe("/bin/keepdeck");
    expect(textarea("mcp-args").value).toBe("--mcp-shim\n/home/mcp.sock");
    expect(input("mcp-command").readOnly).toBe(true);
    expect(button("Save")).toBeUndefined();
    expect(button("Delete")).toBeUndefined();
    expect(document.body.textContent).toContain("Ships with KeepDeck");
    // Nothing that names the pane's secret is typed into: no environment
    // block is offered for a read-only row.
    expect(document.querySelector("#mcp-env")).toBeNull();
  });

  it("creates a local server from the typed lines, through the library", async () => {
    render();
    act(() => buttonByTitle("New global server")!.click());
    act(() => type(input("mcp-name"), "github"));
    act(() => type(input("mcp-command"), "npx"));
    act(() => type(textarea("mcp-args"), "-y\n@modelcontextprotocol/server-github"));
    act(() => type(textarea("mcp-env"), "GITHUB_PERSONAL_ACCESS_TOKEN=ghp_x"));
    expect(button("Create")!.disabled).toBe(false);
    await act(async () => button("Create")!.click());

    expect(lib.save).toHaveBeenCalledWith(
      { kind: "global" },
      {
        name: "github",
        body: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_x" },
        },
      },
      "create",
    );
    // Landed: the row is listed and the editor is anchored on it.
    expect(row("github")).toBeDefined();
    expect(document.querySelector(".library__editor-title")?.textContent).toBe("github");
  });

  it("creates a remote server once the transport is switched", async () => {
    render();
    act(() => buttonByTitle("New workspace server")!.click());
    act(() => type(input("mcp-name"), "gh-remote"));
    act(() => button("Remote endpoint")!.click());
    expect(button("Create")!.disabled).toBe(true); // no url yet
    act(() => type(input("mcp-url"), "https://api.githubcopilot.com/mcp/"));
    act(() => type(textarea("mcp-headers"), "X-Org: keepdeck"));
    act(() => type(input("mcp-token"), "ghp_y"));
    await act(async () => button("Create")!.click());

    expect(lib.save).toHaveBeenCalledWith(
      { kind: "workspace", wsId: "ws-1" },
      {
        name: "gh-remote",
        body: {
          transport: "http",
          url: "https://api.githubcopilot.com/mcp/",
          headers: { "X-Org": "keepdeck" },
          bearerToken: "ghp_y",
        },
      },
      "create",
    );
  });

  it("refuses a line that is not a pair, and names it", () => {
    render();
    act(() => buttonByTitle("New global server")!.click());
    act(() => type(input("mcp-name"), "x"));
    act(() => type(input("mcp-command"), "npx"));
    act(() => type(textarea("mcp-env"), "TOKEN=1\nnot a pair"));
    expect(button("Create")!.disabled).toBe(true);
    expect(document.body.textContent).toContain("This line is not a pair: not a pair");
  });

  it("blocks a colliding or invalid name, in the domain's words", () => {
    lib.servers = [server("github")];
    render();
    act(() => buttonByTitle("New global server")!.click());
    act(() => type(input("mcp-command"), "npx"));
    act(() => type(input("mcp-name"), "github"));
    expect(document.body.textContent).toContain("already exists in this scope");
    expect(button("Create")!.disabled).toBe(true);
    act(() => type(input("mcp-name"), "my.server"));
    expect(document.body.textContent).toContain("letters, digits, hyphens and underscores");
  });

  it("lists a file the codec could not read with its reason, and opens it for repair", async () => {
    lib.servers = [
      { scope: { kind: "global" }, name: "broken", verdict: { kind: "malformed", reason: 'unknown field "x"' } },
    ];
    render();
    expect(row("broken")?.textContent).toContain('Cannot be read — unknown field "x"');
    act(() => row("broken")!.click());
    expect(document.body.textContent).toContain("could not be read");
    expect(input("mcp-name").value).toBe("broken");
    act(() => type(input("mcp-command"), "npx"));
    await act(async () => button("Save")!.click());
    expect(lib.save).toHaveBeenCalledWith(
      { kind: "global" },
      { name: "broken", body: { transport: "stdio", command: "npx", args: [], env: {} } },
      "update",
    );
  });

  it("deleting asks first and routes through the library", async () => {
    lib.servers = [server("github")];
    render();
    act(() => row("github")!.click());
    act(() => button("Delete")!.click());
    // In-app confirm, not a system dialog.
    expect(document.body.textContent).toContain('Delete "github"?');
    const confirmDelete = Array.from(
      document.querySelector(".confirm")!.querySelectorAll("button"),
    ).find((b) => b.textContent === "Delete")!;
    await act(async () => confirmDelete.click());
    expect(lib.remove).toHaveBeenCalledWith({ kind: "global" }, "github");
    expect(row("github")).toBeUndefined();
  });

  it("guards unsaved edits behind a discard confirm on close", () => {
    lib.servers = [server("github")];
    render();
    act(() => row("github")!.click());
    act(() => type(input("mcp-command"), "bunx"));
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Close MCP servers"]')!.click());
    expect(document.body.textContent).toContain("unsaved changes");
    expect(onClose).not.toHaveBeenCalled();
    act(() => button("Discard")!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says the deck's server is not up yet when there is no invocation", () => {
    statusState.current = { ...statusState.current, connect: null };
    try {
      render();
      act(() => row("keepdeck")!.click());
      expect(document.body.textContent).toContain("not up yet");
    } finally {
      statusState.current = {
        ...statusState.current,
        connect: { command: "/bin/keepdeck", args: ["--mcp-shim", "/home/mcp.sock"] },
      };
    }
  });
});
