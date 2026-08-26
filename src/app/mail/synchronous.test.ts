import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The mail owner mutates its state SYNCHRONOUSLY, and that is a contract.
 *
 * Everything the deck knows about mail — the queues, the journal, the debts —
 * lives in one object on one thread, and every operation on it runs to
 * completion without yielding. That is what makes a cancel and a read unable
 * to interleave: whichever arrives first finishes first, and the second sees
 * a settled world. No lock does that work, because none is needed.
 *
 * The guarantee is invisible in the code. One `await` added in good faith —
 * to delete an attachment, to ask the host something — hands the thread back
 * mid-operation, and another command runs inside the gap. A cancel that had
 * decided a message was still cancellable would then remove it after a read
 * had already handed it over.
 *
 * So the rule is: decide and mutate first, in one synchronous block; do
 * anything slow AFTER the state already says the message is gone. This guard
 * is what keeps that rule from depending on everyone remembering it.
 */
describe("the mail owner's synchronous contract", () => {
  const OWNER = "src/app/mail/mailManager.ts";

  it("has no await and no async function in it", () => {
    const source = readFileSync(OWNER, "utf8");
    // Comments talk ABOUT awaiting — the contract has to be explained
    // somewhere — so only code is searched.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

    const offenders = [
      ...code.matchAll(/\bawait\b|\basync\b|\.then\s*\(/g),
    ].map((match) => match[0]);
    expect(
      offenders,
      `${OWNER} must stay synchronous: a cancel and a read are kept apart by run-to-completion, not by a lock. Anything slow belongs at a caller, after this file has already changed the state.`,
    ).toEqual([]);
  });

  it("is watching a file that still exists and still holds the state", () => {
    // A guard that silently starts checking nothing is worse than none: the
    // path could be renamed and this would go on passing over an empty read.
    const source = readFileSync(OWNER, "utf8");
    expect(source).toContain("export function createMailManager");
    expect(source).toContain("const queues = new Map");
    expect(source).toContain("const inboxes = new Map");
  });
});
