// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { domRealm } from "./realmPlugin";

/** The production realm's iframe MUST carry both sandbox tokens: `allow-scripts`
 * to run the guest, and `allow-same-origin` so the document keeps its own
 * kdplugin://<id> origin — without the latter it gets an opaque origin and its
 * own CSP `script-src 'self'` refuses to load its main bundle, so the realm never
 * boots (caught in live verification, this locks it in). */
describe("domRealm", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("creates a hidden iframe with allow-scripts AND allow-same-origin", () => {
    // happy-dom can't fetch kdplugin://, so the realm promise rejects via the
    // iframe's error event after this test returns; swallow it — the sync
    // attributes are the subject here, and an unhandled rejection fails the
    // whole run's exit code.
    domRealm.openRealm("kdplugin://dev.x/__main__.html").catch(() => {});
    const frame = document.body.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(frame!.hidden).toBe(true);
    expect(frame!.sandbox.contains("allow-scripts")).toBe(true);
    expect(frame!.sandbox.contains("allow-same-origin")).toBe(true);
    // Nothing broader crept in — no top-navigation/forms/popups.
    expect(frame!.sandbox.length).toBe(2);
  });

  /** The host-RPC port is a capability. It must be addressed to the realm's
   * own origin — which for `kdplugin://` has to be composed by hand, since
   * `URL.origin` yields the string "null" for a non-special scheme. */
  it("hands the connect port to the realm's origin, not to any listener", async () => {
    const opened = domRealm.openRealm("kdplugin://dev.x/__main__.html");
    const frame = document.body.querySelector("iframe")!;
    const posted: unknown[][] = [];
    Object.defineProperty(frame, "contentWindow", {
      configurable: true,
      value: { postMessage: (...args: unknown[]) => posted.push(args) },
    });

    frame.dispatchEvent(new Event("load"));
    const realm = await opened;
    const port = new MessageChannel().port1;
    realm.post(port);

    expect(posted).toHaveLength(1);
    expect(posted[0][0]).toBe("kd-connect");
    expect(posted[0][1]).toBe("kdplugin://dev.x");
    expect(posted[0][2]).toEqual([port]);
  });
});
