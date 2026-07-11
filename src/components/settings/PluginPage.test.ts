import { describe, expect, it } from "vitest";
import { sectionFor } from "./PluginPage";

describe("sectionFor", () => {
  const files = { label: "Files", fields: [] };
  const run = { label: "Run", fields: [] };
  const contributions = [
    { pluginId: "keepdeck.files", entry: files },
    { pluginId: "keepdeck.run", entry: run },
  ];

  it("answers each plugin's own section", () => {
    expect(sectionFor(contributions, "keepdeck.files")).toBe(files);
    expect(sectionFor(contributions, "keepdeck.run")).toBe(run);
  });

  it("answers null for a plugin without one — its page simply has no fields", () => {
    expect(sectionFor(contributions, "keepdeck.claude")).toBeNull();
    expect(sectionFor([], "keepdeck.files")).toBeNull();
  });
});
