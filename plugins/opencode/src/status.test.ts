import { describe, expect, it } from "vitest";
import { normalizeOpencodeStatus } from "./status";

/** One bus event as the reporter forwards it: type and properties, verbatim. */
const wrap = (type: string, properties: Record<string, unknown> = {}) => ({
  agent: "opencode",
  event: { type, properties },
});

/** A finished assistant message, optionally carrying an error name. */
const finished = (error?: string) =>
  wrap("message.updated", {
    info: {
      role: "assistant",
      time: { completed: 1 },
      ...(error ? { error: { name: error, data: { message: "Aborted" } } } : {}),
    },
  });

describe("normalizeOpencodeStatus", () => {
  describe("the runner's state", () => {
    it("opens a turn on busy", () => {
      expect(
        normalizeOpencodeStatus(
          wrap("session.status", { status: { type: "busy" } }),
          100,
        ),
      ).toEqual({ kind: "turn-start", at: 100 });
    });

    it("says nothing on the idle STATUS — the idle EVENT is its other half", () => {
      expect(
        normalizeOpencodeStatus(
          wrap("session.status", { status: { type: "idle" } }),
          100,
        ),
      ).toBeNull();
    });

    it("says nothing while a step waits to be retried — that turn is alive", () => {
      expect(
        normalizeOpencodeStatus(
          wrap("session.status", {
            status: { type: "retry", attempt: 2, message: "overloaded", next: 5 },
          }),
          100,
        ),
      ).toBeNull();
    });

    it("ends a turn on idle", () => {
      expect(normalizeOpencodeStatus(wrap("session.idle"), 200)).toEqual({
        kind: "turn-end",
        at: 200,
      });
    });
  });

  describe("what an error name means for the turn", () => {
    it("reads an abort as an interruption, never as a failure", () => {
      expect(
        normalizeOpencodeStatus(
          wrap("session.error", { error: { name: "MessageAbortedError" } }),
          500,
        ),
      ).toEqual({ kind: "interrupted", at: 500 });
    });

    it("keeps quiet while an overflowed context compacts — the turn continues", () => {
      expect(
        normalizeOpencodeStatus(
          wrap("session.error", { error: { name: "ContextOverflowError" } }),
          500,
        ),
      ).toBeNull();
    });

    it("keeps quiet when the provider refuses — the turn ends through its own idle", () => {
      expect(
        normalizeOpencodeStatus(
          wrap("session.error", { error: { name: "ContentFilterError" } }),
          500,
        ),
      ).toBeNull();
    });

    it("fails the turn on a real breakdown, carrying the name and the prose", () => {
      expect(
        normalizeOpencodeStatus(
          wrap("session.error", {
            error: { name: "ProviderAuthError", data: { message: "no key" } },
          }),
          500,
        ),
      ).toEqual({
        kind: "turn-failed",
        at: 500,
        error: "ProviderAuthError",
        detail: "no key",
      });
    });

    it("fails honestly when the error has no name at all", () => {
      expect(normalizeOpencodeStatus(wrap("session.error"), 500)).toEqual({
        kind: "turn-failed",
        at: 500,
        error: "unknown",
      });
    });

    it("carries a real error name through to the failure verbatim", () => {
      expect(
        normalizeOpencodeStatus(
          wrap("session.error", { error: { name: "UnknownError" } }),
          500,
        ),
      ).toEqual({ kind: "turn-failed", at: 500, error: "UnknownError" });
    });

    /**
     * The table names only the fates that are known; everything else falls to
     * failure, which is the honest default — those are the errors that did
     * break something. It also guards the case nobody will remember: a name
     * opencode adds tomorrow must arrive loudly rather than be swallowed.
     *
     * `MessageOutputLengthError` is such a name today — declared upstream and
     * constructed nowhere. It gets no row deliberately: a row would add no
     * behaviour and a false sense of coverage, while the default is already
     * structurally right for it.
     */
    it("fails on a name it has never heard of rather than swallowing it", () => {
      expect(
        normalizeOpencodeStatus(
          wrap("session.error", { error: { name: "SomeFutureError" } }),
          500,
        ),
      ).toEqual({ kind: "turn-failed", at: 500, error: "SomeFutureError" });
    });
  });

  describe("the anchor on a finished message", () => {
    it("reads an interrupt that published no error of its own", () => {
      expect(normalizeOpencodeStatus(finished("MessageAbortedError"), 600)).toEqual(
        { kind: "interrupted", at: 600 },
      );
    });

    it("leaves an ordinary finished turn alone", () => {
      expect(normalizeOpencodeStatus(finished(), 600)).toBeNull();
    });

    it("leaves a turn that was already failing when it was cut", () => {
      expect(normalizeOpencodeStatus(finished("APIError"), 600)).toBeNull();
    });

    it("ignores a message still streaming", () => {
      expect(
        normalizeOpencodeStatus(
          wrap("message.updated", { info: { role: "assistant" } }),
          600,
        ),
      ).toBeNull();
    });
  });

  describe("waiting on a human", () => {
    it("parks on an approval prompt", () => {
      expect(normalizeOpencodeStatus(wrap("permission.asked"), 300)).toEqual({
        kind: "waiting",
        at: 300,
        reason: "permission",
      });
    });

    it("parks on a question, which nothing else on the bus reports", () => {
      expect(
        normalizeOpencodeStatus(
          wrap("question.asked", {
            questions: [{ question: "colour?", options: [{ label: "red" }] }],
          }),
          300,
        ),
      ).toEqual({ kind: "waiting", at: 300, reason: "question" });
    });

    it("resumes on every answer, refusals included", () => {
      for (const type of [
        "permission.replied",
        "question.replied",
        "question.rejected",
      ]) {
        expect(normalizeOpencodeStatus(wrap(type), 400)).toEqual({
          kind: "resumed",
          at: 400,
        });
      }
    });
  });

  it("drops what it does not recognise rather than guessing", () => {
    expect(normalizeOpencodeStatus(wrap("session.compacted"), 100)).toBeNull();
    expect(normalizeOpencodeStatus({ agent: "opencode" }, 100)).toBeNull();
    expect(normalizeOpencodeStatus(null, 100)).toBeNull();
  });
});
