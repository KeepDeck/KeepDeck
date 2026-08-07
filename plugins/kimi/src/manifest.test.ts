import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * kimi arms its hooks from a SHIPPED manifest rather than from code, so
 * nothing type-checks it and nothing else in this suite reads it. That is
 * exactly why it is pinned here: the reporter is silent on failure, so a
 * wrong command in this file stops status — or mail — with no error
 * anywhere.
 */
const manifest = JSON.parse(
  readFileSync(
    new URL(
      "../resources/keepdeck-session-reporter/kimi.plugin.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { hooks: { event: string; command: string; timeout: number }[] };

const commandFor = (event: string) =>
  manifest.hooks.find((hook) => hook.event === event)?.command;

describe("kimi companion manifest", () => {
  it("asks the deck back only where an answer can be acted on", () => {
    // Blocked Stop may append a message to let the model continue, and text
    // returned from UserPromptSubmit is appended to the context. The rest
    // report a fact and read nothing back, so asking there would cost a
    // round trip per event for nothing.
    expect(commandFor("Stop")).toBe("/bin/sh ./kd-status-hook.sh kimi --ask");
    expect(commandFor("UserPromptSubmit")).toBe(
      "/bin/sh ./kd-status-hook.sh kimi --ask",
    );
    for (const event of ["StopFailure", "Interrupt", "PermissionRequest", "PermissionResult"]) {
      expect(commandFor(event), event).toBe("/bin/sh ./kd-status-hook.sh kimi");
    }
  });

  it("keeps identity on its own reporter, which never asks", () => {
    // The session hook answers a different question entirely and takes no
    // reply; arming it to ask would make it wait for a file nobody writes.
    expect(commandFor("SessionStart")).toBe("/bin/sh ./kd-session-hook.sh kimi");
  });

  it("leaves every hook room to wait for the deck", () => {
    // The ask loop waits ~2s before giving up. A timeout below that would
    // kill the hook mid-wait and mail would never arrive — and kimi
    // enforces its timeout with a signal, so the reporter would die rather
    // than degrade.
    for (const hook of manifest.hooks) {
      expect(hook.timeout, hook.event).toBeGreaterThanOrEqual(5);
    }
  });
});
