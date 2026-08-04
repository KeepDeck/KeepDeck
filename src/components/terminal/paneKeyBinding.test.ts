import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerTerminalPaneKeys } from "./paneKeyBinding";
import { subscribePaneKeys } from "../../app/paneKeys";

/** A terminal that records WHICH of its two streams was subscribed, so a
 * rewire to the data stream is caught even if it somehow type-checked. */
function fakeTerm() {
  const keyListeners: ((event: { key: string }) => void)[] = [];
  const dataListeners: ((data: string) => void)[] = [];
  return {
    term: {
      onKey(listener: (event: { key: string }) => void) {
        keyListeners.push(listener);
        return {
          dispose: () => {
            keyListeners.splice(keyListeners.indexOf(listener), 1);
          },
        };
      },
      onData(listener: (data: string) => void) {
        dataListeners.push(listener);
        return {
          dispose: () => {
            dataListeners.splice(dataListeners.indexOf(listener), 1);
          },
        };
      },
    },
    press: (bytes: string) => {
      for (const listener of [...keyListeners]) listener({ key: bytes });
    },
    emitData: (bytes: string) => {
      for (const listener of [...dataListeners]) listener(bytes);
    },
    subscribed: () => ({
      key: keyListeners.length,
      data: dataListeners.length,
    }),
  };
}

const seen: [string, string][] = [];
const stopWatching = subscribePaneKeys((paneId, data) =>
  seen.push([paneId, data]),
);
afterAll(stopWatching);

/** Bindings registered by a case, retired with it — the fake terminal dies
 * either way, but leaving them running would hide a missing disposer. */
let registered: (() => void)[];
beforeEach(() => {
  registered = [];
  seen.splice(0);
});
afterEach(() => {
  for (const unregister of registered.splice(0)) unregister();
});

const bind = (paneId: string, term: ReturnType<typeof fakeTerm>["term"]) => {
  const unregister = registerTerminalPaneKeys(paneId, term);
  registered.push(unregister);
  return unregister;
};

describe("registerTerminalPaneKeys", () => {
  it("reports the pane's keystrokes", () => {
    const fake = fakeTerm();
    bind("pane-1", fake.term);
    fake.press("\r");
    fake.press("y");
    expect(seen).toEqual([
      ["pane-1", "\r"],
      ["pane-1", "y"],
    ]);
  });

  it("takes the KEY stream and leaves the data stream alone", () => {
    // The one thing this seam exists for. xterm answers the PROGRAM's own
    // terminal queries on `onData`, so a pane wired there lets an agent
    // answer its own approval prompt just by repainting — the defect this
    // binding was extracted to make impossible to reintroduce.
    const fake = fakeTerm();
    bind("pane-1", fake.term);
    expect(fake.subscribed()).toEqual({ key: 1, data: 0 });

    fake.emitData("\x1b[24;80R"); // a cursor-position reply
    expect(seen).toEqual([]);
  });

  it("stops reporting once disposed", () => {
    const fake = fakeTerm();
    bind("pane-1", fake.term)();
    expect(fake.subscribed().key).toBe(0);
    fake.press("\r");
    expect(seen).toEqual([]);
  });

  it("names the pane it was registered for", () => {
    const first = fakeTerm();
    const second = fakeTerm();
    bind("pane-1", first.term);
    bind("pane-2", second.term);
    second.press("n");
    expect(seen).toEqual([["pane-2", "n"]]);
  });
});
