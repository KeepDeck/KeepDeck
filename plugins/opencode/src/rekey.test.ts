import { describe, expect, it } from "vitest";
import { rekeyExportV1, rekeyExportV2, remintId, type V1Export, type V2Export } from "./rekey";

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
function sample(): V1Export {
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

describe("rekeyExportV1", () => {
  it("sets info.directory (the declared field) and forks the title", () => {
    // NOTE: import binds the real directory from its launch CWD (see fork.ts);
    // info.directory is set only so the clone's declared dir is honest.
    const { document: rekeyed } = rekeyExportV1(sample(), "/new/target", { bytes: counterBytes() });
    expect(rekeyed.info.directory).toBe("/new/target");
    expect(rekeyed.info.title).toBe("Prime session bootstrap (fork)");
    // projectID is left alone — import re-derives it from the directory.
    expect(rekeyed.info.projectID).toBe("proj-source");
    expect(rekeyed.info.version).toBe("1.17.13"); // passthrough survives
  });

  it("mints a fresh session id and returns it", () => {
    const { document: rekeyed, newSessionId } = rekeyExportV1(sample(), "/t", { bytes: counterBytes() });
    expect(newSessionId).not.toBe(SRC);
    expect(rekeyed.info.id).toBe(newSessionId);
  });

  it("mints fresh message + part ids and rewrites every link", () => {
    const { document: rekeyed, newSessionId } = rekeyExportV1(sample(), "/t", { bytes: counterBytes() });
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
    rekeyExportV1(src, "/t", { bytes: counterBytes() });
    expect(src).toEqual(snapshot);
  });

  it("leaves an empty title alone (no ' (fork)' on nothing)", () => {
    const noTitle = sample();
    noTitle.info.title = "";
    const { document: rekeyed } = rekeyExportV1(noTitle, "/t", { bytes: counterBytes() });
    expect(rekeyed.info.title).toBe("");
  });

  it("leaves an absent (undefined) title alone", () => {
    const noTitle = sample();
    delete noTitle.info.title;
    const { document: rekeyed } = rekeyExportV1(noTitle, "/t", { bytes: counterBytes() });
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
    const doc: V1Export = {
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
    const { document: rekeyed } = rekeyExportV1(doc, "/t", { bytes: counterBytes() });
    const newIds = rekeyed.messages[0].parts!.map((p) => String(p.id));
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
    const doc: V1Export = {
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
    expect(() => rekeyExportV1(doc, "/t", { bytes: counterBytes() })).not.toThrow();
  });

  it("handles a message with parts absent, a part with no id, and empty messages", () => {
    const doc: V1Export = {
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
    const { document: rekeyed, newSessionId } = rekeyExportV1(doc, "/t", { bytes: counterBytes() });
    expect(rekeyed.messages[0].parts).toBeUndefined();
    expect(rekeyed.messages[1].parts![0].id).toBeUndefined(); // no id → not minted
    expect(rekeyed.messages[1].parts![0].sessionID).toBe(newSessionId); // still re-linked

    const empty = rekeyExportV1(
      { info: { id: SRC, directory: "/d", title: "t" }, messages: [] },
      "/t",
      { bytes: counterBytes() },
    );
    expect(empty.document.messages).toEqual([]);
    expect(empty.newSessionId).not.toBe(SRC);
  });

  it("throws LOUDLY on an unexpected id layout (opencode format drift)", () => {
    const bytes = counterBytes();
    expect(() => remintId("no-underscore-here", bytes)).toThrow("unexpected opencode id layout");
    expect(() => remintId("UPPER_prefix123456", bytes)).toThrow("unexpected opencode id layout");
    // A drifted session id surfaces the same way through the rekey.
    const bad = sample();
    bad.info.id = "weirdformat";
    expect(() => rekeyExportV1(bad, "/t", { bytes: counterBytes() })).toThrow(
      "unexpected opencode id layout",
    );
  });
});

describe("rekeyExportV1 — the links between turns", () => {
  /** The sample with its answer naming the user turn it answers, as 1.x
   * exports every finished answer (isolated/v1193/export-source). */
  function answered(): V1Export {
    const doc = sample();
    doc.messages[1].info.parentID = doc.messages[0].info.id;
    return doc;
  }

  it("points the clone's answer at the clone's user turn, not the source's", () => {
    // Measured on 1.19.3 before this: the clone imported, and its answer
    // still named the source's user message.
    const { document } = rekeyExportV1(answered(), "/t", { bytes: counterBytes() });
    const [user, answer] = document.messages;
    expect(answer.info.parentID).toBe(user.info.id);
    expect(answer.info.parentID).not.toBe("msg_f2461db4d001rzij8gRRPwcFG1");
  });

  it("links forward as well as back: every id is minted before any link is rewritten", () => {
    const doc = answered();
    doc.messages.reverse();
    const { document } = rekeyExportV1(doc, "/t", { bytes: counterBytes() });
    const [answer, user] = document.messages;
    expect(answer.info.parentID).toBe(user.info.id);
  });

  it("refuses a link to a turn the export does not hold, rather than carry it into the clone", () => {
    const doc = answered();
    doc.messages[1].info.parentID = "msg_f2461db40000nOTinTHISsess0";
    expect(() => rekeyExportV1(doc, "/t", { bytes: counterBytes() })).toThrow(
      "parentID msg_f2461db40000nOTinTHISsess0 names no message of this session",
    );
  });

  it("ties every part to the message it sits under", () => {
    const doc = answered();
    const part = doc.messages[0].parts?.[0];
    if (part) part.messageID = "msg_f2461db40000sTALElink0000";
    const { document } = rekeyExportV1(doc, "/t", { bytes: counterBytes() });
    expect(document.messages[0].parts?.[0]?.messageID).toBe(document.messages[0].info.id);
  });
});

describe("rekeyExportV2", () => {
  /** A 2.x export as 2.1.4 printed it (isolated/v214/export-source): flat
   * messages, a tool call and a shell with ids of their own. */
  function sampleV2(): V2Export {
    return {
      info: {
        id: SRC,
        projectID: "18cba9d94602846eb9cd65028e26e6c4d43ec0c1",
        title: "task457 source v214",
        subpath: "../A",
        location: { directory: "/tmp/kd-task378/isolated/v214/A" },
      },
      messages: [
        { id: "msg_f2461db4d001rzij8gRRPwcFG1", type: "user", text: "What is 2 + 2?" },
        {
          id: "msg_f2461db59001yU4L8wO2GP6bj9",
          type: "assistant",
          content: [
            { type: "text", text: "4." },
            { type: "tool", id: "call_task457_same", name: "read" },
          ],
          snapshot: { start: "snap_start", end: "snap_end" },
        },
        { id: "msg_f2461db5a001shELLshELLsh00", type: "shell", shellID: "sh_task457_same" },
      ],
    };
  }

  it("mints the session's id and every message's — what the import refuses to see twice", () => {
    const { document, newSessionId } = rekeyExportV2(sampleV2(), { bytes: counterBytes() });
    expect(document.info.id).toBe(newSessionId);
    expect(newSessionId).not.toBe(SRC);
    const before = sampleV2().messages.map((message) => message.id);
    const after = document.messages.map((message) => message.id);
    after.forEach((id, i) => expect(id).not.toBe(before[i]));
    expect(new Set(after).size).toBe(after.length);
  });

  it("keeps what is not a message id: a tool call's id, a shell's id, the snapshot", () => {
    const { document } = rekeyExportV2(sampleV2(), { bytes: counterBytes() });
    expect(document.messages[1]).toMatchObject({
      content: [{ type: "text", text: "4." }, { type: "tool", id: "call_task457_same" }],
      snapshot: { start: "snap_start", end: "snap_end" },
    });
    expect(document.messages[2]).toMatchObject({ shellID: "sh_task457_same" });
  });

  it("leaves the place to the import's --directory, invents no field, and marks the title", () => {
    const { document } = rekeyExportV2(sampleV2(), { bytes: counterBytes() });
    expect(document.info.location).toEqual({ directory: "/tmp/kd-task378/isolated/v214/A" });
    expect(document.info.title).toBe("task457 source v214 (fork)");
    expect(document.info).not.toHaveProperty("directory");
    for (const message of document.messages) expect(message).not.toHaveProperty("sessionID");
  });

  it("never mutates the source document", () => {
    const source = sampleV2();
    rekeyExportV2(source, { bytes: counterBytes() });
    expect(source).toEqual(sampleV2());
  });

  it("rewrites a link between messages, should one appear — and refuses one it cannot place", () => {
    const linked = sampleV2();
    linked.messages[1].parentID = linked.messages[0].id;
    const { document } = rekeyExportV2(linked, { bytes: counterBytes() });
    expect(document.messages[1].parentID).toBe(document.messages[0].id);

    const stray = sampleV2();
    stray.messages[1].parentID = "msg_f2461db40000nOTinTHISsess0";
    expect(() => rekeyExportV2(stray, { bytes: counterBytes() })).toThrow("names no message");
  });
});
