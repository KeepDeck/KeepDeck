import { describe, expect, it } from "vitest";
import { report } from "./settings.testSupport";

/**
 * What a load reports about the file it read. This exists so a "my settings
 * reset" report is answerable from the log, which makes a WRONG report worse
 * than none: both directions are pinned below.
 */

describe("a load reports the stored revision", () => {
  it("reads the document's own version", () => {
    expect(report('{"version":9,"scrollback":30000}').version).toBe(9);
  });

  it("says so when the document is unstamped", () => {
    expect(report('{"scrollback":30000}').version).toBeNull();
  });
});

describe("a load reports what it discarded", () => {
  it("names each key whose value it could not use", () => {
    expect(
      report(
        JSON.stringify({
          version: 9,
          scrollback: "lots", // not a number
          dockMode: "sideways", // outside the allow-list
          mcpServer: true, // fine
        }),
      ).degraded,
    ).toEqual(["scrollback", "dockMode"]);
  });

  it("says nothing about a key the file never mentioned", () => {
    expect(report("{}").degraded).toEqual([]);
  });

  it("does NOT accuse a valid bag that merely equals its default", () => {
    // This was the false alarm: the readers answered "unusable" for an
    // all-default bag, so the one log line added for diagnosability claimed
    // values had been dropped from a file it had understood perfectly.
    expect(
      report(
        '{"notifications":{"enabled":true,"mode":"system-and-app","mutedPlugins":[]},"plugins":{"enabled":{},"values":{},"consented":{}}}',
      ).degraded,
    ).toEqual([]);
  });

  it("names a discard INSIDE a bag, which used to pass silently", () => {
    // The mirror failure: the bag as a whole was usable, so nothing was
    // reported, while a rejected mode and a dropped plugin entry vanished.
    expect(
      report(
        JSON.stringify({
          notifications: { enabled: false, mode: "bogus" },
          plugins: { enabled: { good: true, bad: "yes" }, values: { x: 3 } },
        }),
      ).degraded,
    ).toEqual([
      "plugins.enabled.bad",
      "plugins.values.x",
      "notifications.mode",
    ]);
  });

  it("names a whole sub-field that was not even a map", () => {
    expect(
      report('{"plugins":{"enabled":"nope"},"notifications":{"mutedPlugins":7}}').degraded,
    ).toEqual(["plugins.enabled", "notifications.mutedPlugins"]);
  });

  it("reports the key itself when the value is not a record at all", () => {
    expect(report('{"plugins":"nope","notifications":3}').degraded).toEqual([
      "plugins",
      "notifications",
    ]);
  });
});
