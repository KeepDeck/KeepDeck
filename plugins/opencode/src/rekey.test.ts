import { describe, expect, it } from "vitest";
import { rekeyExport, remintId, type OpencodeExport } from "./rekey";

/** Deterministic byte source: a rising counter, so minted tails are
 * predictable and every call yields a DISTINCT tail (ids never collide). */
function counterBytes() {
  let n = 0;
  return (len: number) => {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = n++ & 0xff;
    return out;
  };
}

const SRC = "ses_0db9e24cbffej1WlbsRKynAHf3";

/** A realistic 2-message export: a user text turn and an assistant turn,
 * ids and links all pointing at the source session. */
function sample(): OpencodeExport {
  return {
    info: {
      id: SRC,
      directory: "/Users/u/Projects/app/wt-source",
      projectID: "proj-source",
      title: "Prime session bootstrap",
      version: "1.17.13",
    },
    messages: [
      {
        info: { id: "msg_f2461db4d001rzij8gRRPwcFG1", sessionID: SRC, role: "user" },
        parts: [
          {
            id: "prt_f2461db4d001aaAAaaAAaaAA00",
            messageID: "msg_f2461db4d001rzij8gRRPwcFG1",
            sessionID: SRC,
            type: "text",
            text: "hello",
          },
        ],
      },
      {
        info: { id: "msg_f2461db59001yU4L8wO2GP6bj9", sessionID: SRC, role: "assistant" },
        parts: [],
      },
    ],
  };
}

describe("remintId", () => {
  it("keeps the sortable prefix, remints the tail, preserves length", () => {
    const id = remintId(SRC, counterBytes());
    expect(id).not.toBe(SRC);
    expect(id).toHaveLength(SRC.length);
    expect(id.slice(0, 16)).toBe(SRC.slice(0, 16)); // order-preserving head
  });

  it("gives distinct ids on distinct calls (dedup safety)", () => {
    const bytes = counterBytes();
    expect(remintId(SRC, bytes)).not.toBe(remintId(SRC, bytes));
  });

  it("still remints a degenerate short id, keeping its prefix", () => {
    const id = remintId("ses_abc", counterBytes());
    expect(id.startsWith("ses_")).toBe(true);
    expect(id).not.toBe("ses_abc");
  });
});

describe("rekeyExport", () => {
  it("sets info.directory (the declared field) and forks the title", () => {
    // NOTE: import binds the real directory from its launch CWD (see fork.ts);
    // info.directory is set only so the clone's declared dir is honest.
    const { rekeyed } = rekeyExport(sample(), {
      directory: "/new/target",
      bytes: counterBytes(),
    });
    expect(rekeyed.info.directory).toBe("/new/target");
    expect(rekeyed.info.title).toBe("Prime session bootstrap (fork)");
    // projectID is left alone — import re-derives it from the directory.
    expect(rekeyed.info.projectID).toBe("proj-source");
    expect(rekeyed.info.version).toBe("1.17.13"); // passthrough survives
  });

  it("mints a fresh session id and returns it", () => {
    const { rekeyed, newSessionId } = rekeyExport(sample(), {
      directory: "/t",
      bytes: counterBytes(),
    });
    expect(newSessionId).not.toBe(SRC);
    expect(rekeyed.info.id).toBe(newSessionId);
  });

  it("mints fresh message + part ids and rewrites every link", () => {
    const { rekeyed, newSessionId } = rekeyExport(sample(), {
      directory: "/t",
      bytes: counterBytes(),
    });
    const [m0, m1] = rekeyed.messages;
    // New ids, none equal to the originals.
    expect(m0.info.id).not.toBe("msg_f2461db4d001rzij8gRRPwcFG1");
    expect(m1.info.id).not.toBe("msg_f2461db59001yU4L8wO2GP6bj9");
    // Messages re-parented to the new session.
    expect(m0.info.sessionID).toBe(newSessionId);
    expect(m1.info.sessionID).toBe(newSessionId);
    // The part is re-linked to its message's NEW id and the new session.
    const p0 = m0.parts![0];
    expect(p0.id).not.toBe("prt_f2461db4d001aaAAaaAAaaAA00");
    expect(p0.sessionID).toBe(newSessionId);
    expect(p0.messageID).toBe(m0.info.id);
    // Content rides through untouched.
    expect(p0.text).toBe("hello");
  });

  it("never mutates the source document", () => {
    const src = sample();
    const snapshot = structuredClone(src);
    rekeyExport(src, { directory: "/t", bytes: counterBytes() });
    expect(src).toEqual(snapshot);
  });

  it("leaves an empty title alone (no ' (fork)' on nothing)", () => {
    const noTitle = sample();
    noTitle.info.title = "";
    const { rekeyed } = rekeyExport(noTitle, {
      directory: "/t",
      bytes: counterBytes(),
    });
    expect(rekeyed.info.title).toBe("");
  });

  it("leaves an absent (undefined) title alone", () => {
    const noTitle = sample();
    delete noTitle.info.title;
    const { rekeyed } = rekeyExport(noTitle, {
      directory: "/t",
      bytes: counterBytes(),
    });
    expect(rekeyed.info.title).toBeUndefined();
  });

  it("preserves part order: the sortable id prefix survives reminting", () => {
    // Real opencode part ids carry a monotonic body inside the first 16 chars,
    // so parts of one message differ THERE. remint keeps exactly those 16 chars.
    const partIds = [
      "prt_f2461db4d001zzzzzzzzzzzzzz",
      "prt_f2461db4d002zzzzzzzzzzzzzz",
      "prt_f2461db4d003zzzzzzzzzzzzzz",
    ];
    const doc: OpencodeExport = {
      info: { id: SRC, directory: "/d", title: "t" },
      messages: [
        {
          info: { id: "msg_f2461db4d001rzij8gRRPwcFG1", sessionID: SRC, role: "assistant" },
          parts: partIds.map((id) => ({
            id,
            messageID: "msg_f2461db4d001rzij8gRRPwcFG1",
            sessionID: SRC,
            type: "text",
          })),
        },
      ],
    };
    const { rekeyed } = rekeyExport(doc, { directory: "/t", bytes: counterBytes() });
    const newIds = rekeyed.messages[0].parts!.map((p) => p.id as string);
    // The sort key (first 16 chars) is preserved BYTE-FOR-BYTE — any KEEP≠16
    // would change it and could reorder. This catches the boundary directly,
    // independent of what the random tail happens to be.
    expect(newIds.map((id) => id.slice(0, 16))).toEqual(partIds.map((id) => id.slice(0, 16)));
    // …and the reminted ids therefore still sort in the original order.
    expect([...newIds].sort()).toEqual(newIds);
  });

  it("accepts opencode's synthetic part sentinel (mid-body underscore)", () => {
    // ID_SHAPE allows `_` in the body precisely for `prt_0000000000_thinking`;
    // a regression tightening the class would throw on it in production.
    expect(() => remintId("prt_0000000000_thinking", counterBytes())).not.toThrow();
    const doc: OpencodeExport = {
      info: { id: SRC, directory: "/d", title: "t" },
      messages: [
        {
          info: { id: "msg_f2461db4d001rzij8gRRPwcFG1", sessionID: SRC, role: "assistant" },
          parts: [
            {
              id: "prt_0000000000_thinking",
              messageID: "msg_f2461db4d001rzij8gRRPwcFG1",
              sessionID: SRC,
              type: "thinking",
            },
          ],
        },
      ],
    };
    expect(() => rekeyExport(doc, { directory: "/t", bytes: counterBytes() })).not.toThrow();
  });

  it("handles a message with parts absent, a part with no id, and empty messages", () => {
    const doc: OpencodeExport = {
      info: { id: SRC, directory: "/d", title: "t" },
      messages: [
        // parts key entirely absent
        { info: { id: "msg_f2461db4d001rzij8gRRPwcFG1", sessionID: SRC, role: "assistant" } },
        // a part with no id — remint must skip it, still re-link the session
        {
          info: { id: "msg_f2461db59001yU4L8wO2GP6bj9", sessionID: SRC, role: "user" },
          parts: [{ sessionID: SRC, type: "text", text: "x" }],
        },
      ],
    };
    const { rekeyed, newSessionId } = rekeyExport(doc, { directory: "/t", bytes: counterBytes() });
    expect(rekeyed.messages[0].parts).toBeUndefined();
    expect(rekeyed.messages[1].parts![0].id).toBeUndefined(); // no id → not minted
    expect(rekeyed.messages[1].parts![0].sessionID).toBe(newSessionId); // still re-linked

    const empty = rekeyExport(
      { info: { id: SRC, directory: "/d", title: "t" }, messages: [] },
      { directory: "/t", bytes: counterBytes() },
    );
    expect(empty.rekeyed.messages).toEqual([]);
    expect(empty.newSessionId).not.toBe(SRC);
  });

  it("throws LOUDLY on an unexpected id layout (opencode format drift)", () => {
    const bytes = counterBytes();
    expect(() => remintId("no-underscore-here", bytes)).toThrow("unexpected opencode id layout");
    expect(() => remintId("UPPER_prefix123456", bytes)).toThrow("unexpected opencode id layout");
    // A drifted session id surfaces the same way through rekeyExport.
    const bad = sample();
    bad.info.id = "weirdformat";
    expect(() => rekeyExport(bad, { directory: "/t", bytes: counterBytes() })).toThrow(
      "unexpected opencode id layout",
    );
  });
});
