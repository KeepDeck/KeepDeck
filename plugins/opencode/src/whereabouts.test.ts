import { describe, expect, it } from "vitest";
import type { Whereabouts } from "./store";
import { refusalOf, verdictOn } from "./whereabouts";

/**
 * Whether a pane's opencode may open a session, from where the store says
 * it lives (task-378, task-460). Each row is a case measured or read in the
 * source: what that opencode would do with the session instead.
 */
const COPIED = 5000;
const completed = { state: "completed", at: COPIED } as const;
const pending = { state: "pending" } as const;
const none = { state: "none" } as const;

const at = (where: Partial<Whereabouts>): Whereabouts => ({ migration: completed, ...where });

describe("a 2.x pane", () => {
  it("opens a session in its own tables", () => {
    expect(verdictOn(2, at({ v2: { updated: 7000 } }))).toBe("here");
    // Copied and continued in 2.x: the 2.x half is the newer.
    expect(verdictOn(2, at({ v1: { updated: 1000 }, v2: { updated: 7000 } }))).toBe("here");
    // Copied and not touched since: the copy keeps the time it found.
    expect(verdictOn(2, at({ v1: { updated: 1000 }, v2: { updated: 1000 } }))).toBe("here");
  });

  it("refuses a 1.x-only session while the copy to 2.x has not reached it — 2.x would delete what is typed into it", () => {
    expect(verdictOn(2, at({ v1: { updated: 1000 }, migration: pending }))).toBe("copy-pending");
    // 2.x never started on this store: no 2.x tables yet, everything to copy.
    expect(verdictOn(2, at({ v1: { updated: 1000 }, migration: none }))).toBe("copy-pending");
  });

  it("refuses a session 1.x made after the copy — 2.x would open an empty one under its id", () => {
    expect(verdictOn(2, at({ v1: { updated: 6100 } }))).toBe("other-generation");
  });

  it("refuses a session 1.x went on with after the copy — 2.x has only the half before it", () => {
    expect(verdictOn(2, at({ v1: { updated: 9000 }, v2: { updated: 7000 } }))).toBe("continued-elsewhere");
  });

  it("knows a session in neither table set as nowhere", () => {
    expect(verdictOn(2, at({}))).toBe("nowhere");
  });
});

describe("a 1.x pane", () => {
  it("opens a session in its own tables that 2.x did not go on with", () => {
    expect(verdictOn(1, at({ v1: { updated: 6100 }, migration: none }))).toBe("here");
    expect(verdictOn(1, at({ v1: { updated: 1000 }, v2: { updated: 1000 } }))).toBe("here");
  });

  it("refuses a session 2.x went on with — 1.x would open the half from before the copy", () => {
    expect(verdictOn(1, at({ v1: { updated: 1000 }, v2: { updated: 7000 } }))).toBe("continued-elsewhere");
  });

  it("refuses a session only 2.x has — and never calls it a pending copy", () => {
    expect(verdictOn(1, at({ v2: { updated: 8100 } }))).toBe("other-generation");
    expect(verdictOn(1, at({ v2: { updated: 8100 }, migration: pending }))).toBe("other-generation");
  });
});

describe("the words", () => {
  it("say which opencode has the conversation and which one this pane runs", () => {
    expect(refusalOf("other-generation", 2, "2.1.4", "ses_x")).toBe(
      "This conversation was recorded by opencode 1.x, but this pane runs opencode 2.1.4. Open it with opencode 1.x.",
    );
    expect(refusalOf("continued-elsewhere", 1, "1.19.3", "ses_x")).toBe(
      "This conversation was continued in opencode 2.x, but this pane runs opencode 1.19.3. Open it with opencode 2.x.",
    );
    expect(refusalOf("nowhere", 2, undefined, "ses_x")).toBe("opencode 2.x has no session ses_x.");
  });

  it("send the user to start any opencode 2.x for a pending copy — not this pane, which stays stopped", () => {
    expect(refusalOf("copy-pending", 2, "2.1.4", "ses_x")).toMatch(
      /^opencode 2\.1\.4 has not copied this 1\.x conversation yet\. The copy runs whenever any opencode 2\.x starts .* not this one\./,
    );
  });

  it("are none for a session that can be opened", () => {
    expect(refusalOf("here", 1, "1.19.3", "ses_x")).toBeUndefined();
  });
});
