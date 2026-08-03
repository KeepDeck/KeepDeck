import { describe, expect, it } from "vitest";
import {
  bindingVerdict,
  speaksForPane,
  type BindingClaim,
} from "./sessionAttribution";

/** The pane's own claude reporting its own boot — the shape every case below
 * varies one field of. */
const own: BindingClaim = {
  paneSecret: "tok",
  reportedSecret: "tok",
  paneAgent: "claude",
  reportedAgent: "claude",
  origin: "startup",
  boundThisGeneration: false,
  boundReporter: undefined,
  reportedReporter: "4021",
};

/** The same pane one binding later: its generation is pinned to process 4021. */
const bound: BindingClaim = {
  ...own,
  boundThisGeneration: true,
  boundReporter: "4021",
};

describe("speaksForPane", () => {
  it("refuses to place a report nobody signed", () => {
    expect(speaksForPane("claude", undefined)).toBe(false);
    expect(speaksForPane(undefined, "claude")).toBe(false);
  });
});

describe("bindingVerdict", () => {
  it("accepts the pane's own agent starting up", () => {
    expect(bindingVerdict(own)).toEqual({ accepted: true });
  });

  it("accepts the pane's conversation continuing under a new id", () => {
    // A `/clear` or a resume mints a new session id for the SAME
    // conversation the user is having; refusing it would strand the pane on
    // an id its agent no longer uses.
    expect(bindingVerdict({ ...bound, origin: "swap" })).toEqual({
      accepted: true,
    });
  });

  it("refuses a second fresh session inside one process generation", () => {
    // The teammate case: a full, independent session of the SAME agent, in
    // the SAME process, starting up while the pane's own session is bound.
    // No process boundary is left to see it by, so the origin rule is the
    // only one that can.
    expect(bindingVerdict(bound)).toEqual({
      accepted: false,
      refusal: "second-startup",
    });
  });

  it("refuses another PROCESS however it describes itself", () => {
    // The nested-run case: `claude --resume <other-id>` from a tool call
    // reports a continuation, which walks straight past the origin rule. Its
    // process group is not the one that bound this generation.
    expect(
      bindingVerdict({ ...bound, origin: "swap", reportedReporter: "9137" }),
    ).toEqual({ accepted: false, refusal: "foreign-process" });
    // And the same claim as a fresh start is refused for the process reason,
    // not the origin one — the more specific rule speaks first.
    expect(bindingVerdict({ ...bound, reportedReporter: "9137" })).toEqual({
      accepted: false,
      refusal: "foreign-process",
    });
  });

  it("cannot ask the process question when either side is silent", () => {
    // A reporter whose `ps` failed says nothing, and the origin rule carries
    // the weight alone rather than refusing every rebind on a missing field.
    expect(
      bindingVerdict({ ...bound, origin: "swap", reportedReporter: undefined }),
    ).toEqual({ accepted: true });
    expect(
      bindingVerdict({ ...bound, origin: "swap", boundReporter: undefined }),
    ).toEqual({ accepted: true });
  });

  it("refuses a foreign agent on its very first report", () => {
    // The nested-CLI case: `kimi` run from a tool call inside a claude pane.
    // Nothing has bound yet in this generation, so neither the process rule
    // nor the origin rule can catch it — which is why all three exist.
    expect(bindingVerdict({ ...own, reportedAgent: "kimi" })).toEqual({
      accepted: false,
      refusal: "foreign-agent",
    });
  });

  it("refuses a secret that is not this pane's", () => {
    expect(
      bindingVerdict({ ...own, reportedSecret: "someone-elses" }),
    ).toEqual({ accepted: false, refusal: "wrong-token" });
  });

  it("accepts nothing for a pane that armed no reporter", () => {
    // No secret means no way to tell a report of ours from a file someone
    // dropped in the inbox, so an empty pane secret must never match.
    expect(
      bindingVerdict({ ...own, paneSecret: undefined }),
    ).toEqual({ accepted: false, refusal: "wrong-token" });
    expect(
      bindingVerdict({ ...own, paneSecret: "", reportedSecret: "" }),
    ).toEqual({ accepted: false, refusal: "wrong-token" });
  });
});
