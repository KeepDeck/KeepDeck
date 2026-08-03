import { describe, expect, it } from "vitest";
import {
  bindingOrigin,
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
};

describe("bindingOrigin", () => {
  it("reads every word our agents use for a continuing conversation", () => {
    for (const word of ["resume", "clear", "compact", "fork", "new"]) {
      expect(bindingOrigin(word), word).toBe("swap");
    }
  });

  it("treats a word it does not know as a fresh start, not a continuation", () => {
    // The strict side: an unknown word can then only be refused as a second
    // start. Read as a swap it would overwrite the pane's identity, which is
    // the failure this whole module exists to prevent.
    expect(bindingOrigin("teleported")).toBe("startup");
    expect(bindingOrigin(undefined)).toBe("startup");
    expect(bindingOrigin("")).toBe("startup");
  });
});

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
    expect(
      bindingVerdict({ ...own, origin: "swap", boundThisGeneration: true }),
    ).toEqual({ accepted: true });
  });

  it("refuses a second fresh session inside one process generation", () => {
    // The teammate case: a full, independent session of the SAME agent,
    // holding the pane's inherited secret, starting up while the pane's own
    // session is already bound.
    expect(
      bindingVerdict({ ...own, boundThisGeneration: true }),
    ).toEqual({ accepted: false, refusal: "second-startup" });
  });

  it("refuses a foreign agent on its very first report", () => {
    // The nested-CLI case: `kimi` run from a tool call inside a claude pane.
    // Nothing has bound yet in this generation, so only the agent rule can
    // catch it — which is why the two rules are not one.
    expect(
      bindingVerdict({ ...own, reportedAgent: "kimi" }),
    ).toEqual({ accepted: false, refusal: "foreign-agent" });
  });

  it("refuses a binding nobody signed", () => {
    expect(
      bindingVerdict({ ...own, reportedAgent: undefined }),
    ).toEqual({ accepted: false, refusal: "unattributed" });
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
