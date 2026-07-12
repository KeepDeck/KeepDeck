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
});
