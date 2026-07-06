// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { domRealm } from "./realmPlugin";

/** The production realm's iframe MUST carry both sandbox tokens: `allow-scripts`
 * to run the guest, and `allow-same-origin` so the document keeps its own
 * kdplugin://<id> origin — without the latter it gets an opaque origin and its
 * own CSP `script-src 'self'` refuses to load logic.js, so the realm never
 * boots (caught in live verification, this locks it in). */
describe("domRealm", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("creates a hidden iframe with allow-scripts AND allow-same-origin", () => {
    void domRealm.openRealm("kdplugin://dev.x/__logic__.html");
    const frame = document.body.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(frame!.hidden).toBe(true);
    expect(frame!.sandbox.contains("allow-scripts")).toBe(true);
    expect(frame!.sandbox.contains("allow-same-origin")).toBe(true);
    // Nothing broader crept in — no top-navigation/forms/popups.
    expect(frame!.sandbox.length).toBe(2);
  });
});
