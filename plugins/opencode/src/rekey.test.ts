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
  it("relocates the directory and forks the title", () => {
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

  it("leaves an empty/absent title alone (no ' (fork)' on nothing)", () => {
    const noTitle = sample();
    noTitle.info.title = "";
    const { rekeyed } = rekeyExport(noTitle, {
      directory: "/t",
      bytes: counterBytes(),
    });
    expect(rekeyed.info.title).toBe("");
  });
});
