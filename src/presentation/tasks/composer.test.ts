import { describe, expect, it } from "vitest";
import { EMPTY_COMPOSER, beginSend, composerCanSend, finishSend, labelDraftAfter, labelSendable, typeDraft } from "./composer";

describe("composer", () => {
  it("a send takes the draft as typed, and an accepted send clears only that text", () => {
    const typed = typeDraft(EMPTY_COMPOSER, "first");
    expect(composerCanSend(typed)).toBe(true);
    const begun = beginSend(typed)!;
    expect(begun.body).toBe("first");
    expect(composerCanSend(begun.state)).toBe(false);
    expect(beginSend(begun.state)).toBeNull();
    expect(finishSend(begun.state, true)).toEqual(EMPTY_COMPOSER);
  });

  it("text typed while a send is out is kept — accepted or refused", () => {
    const begun = beginSend(typeDraft(EMPTY_COMPOSER, "first"))!;
    const typedMeanwhile = typeDraft(begun.state, "first and more");
    expect(finishSend(typedMeanwhile, true)).toEqual({ draft: "first and more", sending: null });
    expect(finishSend(typedMeanwhile, false)).toEqual({ draft: "first and more", sending: null });
    expect(finishSend(begun.state, false)).toEqual({ draft: "first", sending: null });
    expect(beginSend(EMPTY_COMPOSER)).toBeNull();
  });

  it("the label field sends a word, and clears only what it sent, only when it landed", () => {
    expect(labelSendable("ui")).toBe(true);
    expect(labelSendable("")).toBe(false);
    expect(labelSendable(" -- ")).toBe(false);
    expect(labelDraftAfter("ui", "ui", true)).toBe("");
    expect(labelDraftAfter("ui", "ui", false)).toBe("ui");
    expect(labelDraftAfter("ui-kit", "ui", true)).toBe("ui-kit");
  });
});
