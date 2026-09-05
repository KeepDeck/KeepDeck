import { describe, expect, it } from "vitest";
import type { McpServerDraft } from "../../domain/mcp";
import {
  EMPTY_MCP_FORM,
  draftOfForm,
  formOfDraft,
  formOfRow,
  keyValueLinesProblem,
} from "./mcpForm";

const local: McpServerDraft = {
  name: "github",
  body: {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_x" },
  },
};
const remote: McpServerDraft = {
  name: "gh-remote",
  body: {
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
    headers: { "X-Org": "keepdeck" },
    bearerToken: "ghp_y",
  },
};

describe("the server form", () => {
  it("round-trips both transports through text and back", () => {
    expect(draftOfForm(formOfDraft(local))).toEqual(local);
    expect(draftOfForm(formOfDraft(remote))).toEqual(remote);
  });

  it("lays a local server out one argument and one NAME=value per line", () => {
    expect(formOfDraft(local)).toMatchObject({
      transport: "stdio",
      command: "npx",
      args: "-y\n@modelcontextprotocol/server-github",
      env: "GITHUB_PERSONAL_ACCESS_TOKEN=ghp_x",
      url: "",
    });
  });

  it("reads lines tolerantly: blanks dropped, edges trimmed, values may hold the separator", () => {
    const draft = draftOfForm({
      ...EMPTY_MCP_FORM,
      name: "x",
      transport: "stdio",
      command: " npx ",
      args: "\n -y \n\n pkg \n",
      env: "A = 1\nURL=http://h:1/p?q=2\n",
    });
    expect(draft.body).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "pkg"],
      env: { A: "1", URL: "http://h:1/p?q=2" },
    });
  });

  it("leaves an empty token out of a remote server", () => {
    const draft = draftOfForm({ ...EMPTY_MCP_FORM, name: "r", transport: "http", url: "https://x/", bearerToken: " " });
    expect(draft.body).toEqual({ transport: "http", url: "https://x/", headers: {} });
  });

  it("names the first line that is not key<sep>value", () => {
    expect(keyValueLinesProblem("A=1\n\nB=2", "=")).toBeNull();
    expect(keyValueLinesProblem("A=1\nnot a pair\nB=2", "=")).toBe("not a pair");
    expect(keyValueLinesProblem("=1", "=")).toBe("=1");
    expect(keyValueLinesProblem("X-Org: keepdeck\n:v", ":")).toBe(":v");
  });

  it("opens a file the codec could not read with its name alone", () => {
    // What the user types replaces the file — the repair path.
    expect(
      formOfRow({ scope: { kind: "global" }, name: "broken", verdict: { kind: "malformed", reason: "r" } }),
    ).toEqual({ ...EMPTY_MCP_FORM, name: "broken" });
  });
});
