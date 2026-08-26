import { afterEach, describe, expect, it } from "vitest";
import { registerPaneInput } from "../paneInput";
import { wakePaneForMail } from "./ptyDelivery";

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

/** A moment past every settle window — the ordinary case, where the pane has
 * been up for a while by the time anything is sent to it. */
const SETTLED = Date.now() + 60_000;

describe("wakePaneForMail", () => {
  it("submits the nudge as its own gesture, paste before the CR", () => {
    // The primary wake for every agent whose mail rides a hook. The ordering
    // is the whole mechanism: xterm wraps a paste in bracketed-paste markers,
    // so a CR concatenated onto the text arrives as pasted CONTENT and the
    // line sits in the composer unsent.
    const calls = pane("pane-2");
    expect(wakePaneForMail("pane-2", SETTLED)).toBe(true);
    expect(calls.map((call) => call.channel)).toEqual(["paste", "write"]);
    expect(calls[1].text).toBe("\r");
  });

  it("says whose line it is, and carries no message", () => {
    // It exists to make a pane take a turn; the words then arrive through
    // the agent's own channel, labelled. Anything typed at a terminal
    // otherwise reads as the person speaking.
    const calls = pane("pane-2");
    wakePaneForMail("pane-2", SETTLED);
    expect(calls[0].text).toContain("[keepdeck]");
    expect(calls[0].text).toContain("not from your user");
    expect(calls[0].text).toContain("mail.inbox");
  });

  it("waits for a pane that has only just become writable", () => {
    // A writer existing is not the CLI reading it. Nudging then leaves the
    // line in a composer that never submits — observed live, and the reason
    // the settle window exists at all.
    pane("pane-2");
    expect(wakePaneForMail("pane-2", Date.now())).toBe(false);
  });

  it("reports a pane with no live session as a retry, writing nothing", () => {
    expect(wakePaneForMail("pane-nobody", SETTLED)).toBe(false);
  });

  it("refuses a type-only pane rather than sending a bare CR", () => {
    const calls = pane("pane-2", { paste: false });
    expect(wakePaneForMail("pane-2", SETTLED)).toBe(false);
    expect(calls).toEqual([]);
  });
});