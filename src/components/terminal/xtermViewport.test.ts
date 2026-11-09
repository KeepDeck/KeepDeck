// @vitest-environment happy-dom
/**
 * The contract `syncScrollArea` holds against the installed xterm: the private
 * viewport it reaches is there, and is asked to re-sync at once — the call
 * xterm's own resize makes. An xterm upgrade that moves it fails here.
 */
import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vitest";
import { isObjectLike } from "../../domain/json";
import { syncScrollArea } from "./xtermViewport";

afterEach(() => {
  document.body.innerHTML = "";
});

/** xterm's private viewport, where `syncScrollArea` looks for it. */
function viewportOf(term: Terminal): Record<string, unknown> {
  const core: unknown = Reflect.get(term, "_core");
  const viewport = isObjectLike(core) ? core.viewport : undefined;
  if (!isObjectLike(viewport)) throw new Error("the installed xterm keeps no viewport where syncScrollArea looks");
  return viewport;
}

describe("syncScrollArea", () => {
  it("asks the installed xterm's viewport to re-sync at once", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const term = new Terminal();
    term.open(host);
    const viewport = viewportOf(term);
    expect(typeof viewport.syncScrollArea).toBe("function");
    const calls: unknown[][] = [];
    viewport.syncScrollArea = (...args: unknown[]) => {
      calls.push(args);
    };

    syncScrollArea(term);

    expect(calls).toEqual([[true]]);
    term.dispose();
  });
});
