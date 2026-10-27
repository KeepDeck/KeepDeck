import { describe, expect, it } from "vitest";
import { capabilitiesInWords } from "./pluginCapabilities";

describe("capabilitiesInWords", () => {
  it("names every capability in the order the manifest lists them", () => {
    expect(
      capabilitiesInWords([
        { kind: "fs", scope: "everywhere" },
        { kind: "net", domains: ["a.example", "b.example"] },
        { kind: "clipboardRead" },
      ]),
    ).toBe("read any file, reach a.example/b.example, read the clipboard (sensitive — it can hold secrets)");
  });

  it("names a kept server's command line and every method it may call", () => {
    expect(
      capabilitiesInWords([
        {
          kind: "exec",
          commands: ["tool", "git"],
          servers: [
            { id: "app", command: "tool", args: ["serve", "--stdio"], methods: ["read", "list"] },
          ],
        },
      ]),
    ).toBe("run tool/git · keep tool serve --stdio running, calls: read, list");
  });

  it("says nothing more for an exec without servers", () => {
    expect(capabilitiesInWords([{ kind: "exec", commands: ["git"] }])).toBe("run git");
  });
});
