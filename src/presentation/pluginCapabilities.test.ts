import { describe, expect, it } from "vitest";
import { NO_PERMISSIONS } from "../plugins/capabilities/permissions";
import { capabilitiesInWords } from "./pluginCapabilities";

describe("capabilitiesInWords", () => {
  it("names every capability in the order the manifest lists them", () => {
    expect(
      capabilitiesInWords(
        [
          { kind: "fs", scope: "everywhere" },
          { kind: "net", domains: ["a.example", "b.example"] },
          { kind: "clipboardRead" },
        ],
        { env: {}, net: [{ allow: ["a.example", "b.example"], credentials: [] }] },
      ),
    ).toBe("read any file, reach a.example/b.example, read the clipboard (sensitive — it can hold secrets)");
  });

  it("names a kept server's command line and every method it may call", () => {
    expect(
      capabilitiesInWords(
        [
          {
            kind: "exec",
            commands: ["tool", "git"],
            servers: [{ id: "app", command: "tool", args: ["serve", "--stdio"], methods: ["read", "list"] }],
          },
        ],
        NO_PERMISSIONS,
      ),
    ).toBe("run tool/git · keep tool serve --stdio running, calls: read, list");
  });

  it("says nothing more for an exec without servers", () => {
    expect(capabilitiesInWords([{ kind: "exec", commands: ["git"] }], NO_PERMISSIONS)).toBe("run git");
  });

  it("names each variable read, and shows both the rule and what it resolved to — never a raw value", () => {
    const words = capabilitiesInWords(
      [
        { kind: "env", names: ["TOOL_HOME", "TOOL_BASE_URL"] },
        { kind: "net", domains: ["127.0.0.1"] },
        {
          kind: "net",
          domains: ["api.tool.example", { env: "TOOL_BASE_URL", default: "https://api.tool.example/v1" }],
          credentials: [
            {
              id: "tool",
              dir: { env: "TOOL_HOME", default: "~/.tool", append: "credentials" },
              tokenFields: ["access_token", "accessToken"],
            },
          ],
        },
      ],
      {
        env: { TOOL_HOME: "/custom", TOOL_BASE_URL: "https://custom.example:8443/base?token=secret" },
        net: [
          { allow: ["127.0.0.1"], credentials: [] },
          {
            allow: ["api.tool.example", "https://custom.example:8443"],
            credentials: [{ id: "tool", dir: "/custom/credentials", tokenFields: ["access_token", "accessToken"] }],
          },
        ],
      },
    );

    expect(words).toBe(
      "read environment TOOL_HOME, TOOL_BASE_URL, reach 127.0.0.1, " +
        "reach api.tool.example/https://custom.example:8443 (TOOL_BASE_URL, else https://api.tool.example/v1)" +
        " · sign requests with tokens from /custom/credentials " +
        "(TOOL_HOME, else ~/.tool, then credentials; fields access_token, accessToken)",
    );
    expect(words).not.toContain("secret");
  });
});
