import { afterEach, describe, expect, it } from "vitest";
import type { Mail } from "../../domain/mail";
import { registerPaneInput } from "../paneInput";
import { deliverMailThroughPty, renderMail } from "./ptyDelivery";

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

/** Register a pane and record what reaches each of its two channels, in
 * the order the channels were used. */
function pane(id: string, options: { paste?: boolean } = {}) {
  const calls: { channel: "paste" | "write"; text: string }[] = [];
  const input = {
    write: (text: string) => calls.push({ channel: "write" as const, text }),
    ...(options.paste === false
      ? {}
      : { paste: (text: string) => calls.push({ channel: "paste" as const, text }) }),
  };
  cleanups.push(registerPaneInput(id, input));
  return calls;
}

function mail(over: Partial<Mail> = {}): Mail {
  return {
    id: "mail-3",
    kind: "question",
    body: "which signature does the port take?",
    from: {
      kind: "pane",
      pane: { paneId: "pane-1", workspaceId: "ws-1", label: "Agent 1" },
    },
    toPaneId: "pane-2",
    at: 1_000,
    hop: 0,
    ...over,
  };
}

describe("renderMail", () => {
  it("names the sender and says plainly that it is not the user", () => {
    const text = renderMail(mail());
    expect(text).toContain("Agent 1");
    expect(text).toContain("not your user");
    expect(text).toContain('replyTo="mail-3"');
    // The body is verbatim and starts its own line — nothing reformats what
    // one agent chose to say to another.
    expect(text.endsWith("\nwhich signature does the port take?")).toBe(true);
  });

  it("names a teammate by its role, so the reply has an address to use", () => {
    // The title is what an agent was shown before, and it dutifully replied
    // to the title — which is not an address, and was refused.
    const text = renderMail(
      mail({
        from: {
          kind: "pane",
          pane: {
            paneId: "pane-1",
            workspaceId: "ws-1",
            label: "Структура команды",
            role: "lead",
          },
        },
      }),
    );
    expect(text).toContain("from lead,");
    expect(text).not.toContain("Структура команды");
  });

  it("falls back to the title for a sender on no team", () => {
    // No role means no address to give; the title is all there is.
    expect(renderMail(mail())).toContain("from Agent 1,");
  });

  it("distinguishes a report from KeepDeck itself", () => {
    const text = renderMail(
      mail({ kind: "undelivered", from: { kind: "host" }, body: "Undelivered: ..." }),
    );
    expect(text).toContain("from KeepDeck itself");
    expect(text).not.toContain("another agent");
  });

  it("keeps the header to a single line, however long the body is", () => {
    // It rides in front of every message; a paragraph of preamble per note
    // would cost more context than the notes are worth.
    const text = renderMail(mail({ body: "one\ntwo\nthree" }));
    expect(text.split("\n")[0]).toContain("keepdeck mail");
    expect(text.split("\n").slice(1)).toEqual(["one", "two", "three"]);
  });
});

/** A moment past every settle window — the ordinary case, where the pane has
 * been up for a while by the time anything is sent to it. */
const SETTLED = Date.now() + 60_000;

describe("deliverMailThroughPty", () => {
  it("refuses a pane that only just became writable, as a retry", () => {
    // "A writer exists" is not "the CLI reads it". Pasting into a starting
    // TUI leaves the text in the composer and loses the submit after it —
    // seen live, twice — and a paste is answered by nothing, so the deck
    // cannot tell that from a delivery. Nothing is written at all.
    const calls = pane("pane-2");
    expect(deliverMailThroughPty(mail(), Date.now())).toBe(false);
    expect(calls).toEqual([]);
  });

  it("pastes the message, then submits with a raw CR outside the paste", () => {
    const calls = pane("pane-2");
    expect(deliverMailThroughPty(mail(), SETTLED)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].channel).toBe("paste");
    expect(calls[0].text).toContain("which signature does the port take?");
    // The order is the whole trick: a CR concatenated onto the pasted text
    // would arrive as pasted CONTENT, and the message would sit unsent.
    expect(calls[1]).toEqual({ channel: "write", text: "\r" });
  });

  it("carries a body containing its own CR without submitting halfway", () => {
    const calls = pane("pane-2");
    expect(deliverMailThroughPty(mail({ body: "stop\rnow" }), SETTLED)).toBe(true);
    // One paste holding the whole body, and exactly one submit after it.
    expect(calls.filter((call) => call.channel === "write")).toEqual([
      { channel: "write", text: "\r" },
    ]);
    expect(calls[0].text).toContain("stop\rnow");
  });

  it("reports a pane with no live session as a retry, writing nothing", () => {
    expect(deliverMailThroughPty(mail({ toPaneId: "pane-nobody" }), SETTLED)).toBe(false);
  });

  it("refuses a type-only pane rather than submitting an empty prompt", () => {
    // A pane with no paste channel would otherwise take the bare CR below
    // and send an empty line into the agent's composer.
    const calls = pane("pane-2", { paste: false });
    expect(deliverMailThroughPty(mail(), SETTLED)).toBe(false);
    expect(calls).toEqual([]);
  });
});
