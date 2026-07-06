import { describe, expect, it, vi } from "vitest";
import type { KeepDeckPlugin } from "@keepdeck/plugin-api";
import { connectPluginGuest } from "../../../packages/plugin-guest/src/connect";
import {
  createFakeHost,
  fakeManifest,
} from "../../../packages/plugin-guest/src/fakeHost";
import { makeExternalPlugin, type RealmDom } from "./realmPlugin";

/** A realm whose "document" is a REAL guest wired over the delivered port —
 * the adapter's orchestration runs against the true RPC stack, minus DOM. */
function fakeRealm(guestPlugin?: KeepDeckPlugin) {
  const close = vi.fn();
  const opened: string[] = [];
  const dom: RealmDom = {
    async openRealm(url) {
      opened.push(url);
      return {
        post(port) {
          if (guestPlugin) connectPluginGuest(port, guestPlugin);
          // No guest → the port dangles, exactly like a hung realm.
        },
        close,
      };
    },
  };
  return { dom, close, opened };
}

const withTabs = (id: string, main?: string) =>
  fakeManifest(id, {
    contributes: { dockTabs: [{ id: "panel", label: "Panel" }] },
    ...(main && { main }),
  });

describe("makeExternalPlugin", () => {
  it("pure-UI: registers the manifest's iframe tabs and opens no realm", async () => {
    const host = createFakeHost();
    const { dom, opened } = fakeRealm();
    const plugin = makeExternalPlugin(withTabs("dev.pure"), dom);

    await plugin.activate(host.ctx);

    expect(opened).toEqual([]);
    expect(host.dockTabs).toEqual([
      { id: "panel", label: "Panel", iframe: "panel.html" },
    ]);
  });

  it("with a main bundle: boots the realm, the guest activates over RPC", async () => {
    const host = createFakeHost();
    const guest: KeepDeckPlugin = {
      activate(ctx) {
        ctx.ui.registerTopBarAction({ id: "go", title: "Go", run: () => {} });
      },
    };
    const { dom, close, opened } = fakeRealm(guest);
    const plugin = makeExternalPlugin(withTabs("dev.logic", "main.js"), dom);

    await plugin.activate(host.ctx);

    expect(opened).toEqual(["kdplugin://dev.logic/__main__.html"]);
    expect(host.dockTabs).toHaveLength(1); // declarative, host-side
    expect(host.topBarActions.map((a) => a.id)).toEqual(["go"]); // via RPC
    expect(close).not.toHaveBeenCalled();

    plugin.deactivate?.();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("a guest whose activate throws fails the activation and closes the realm", async () => {
    const host = createFakeHost();
    const guest: KeepDeckPlugin = {
      activate() {
        throw new Error("guest exploded");
      },
    };
    const { dom, close } = fakeRealm(guest);
    const plugin = makeExternalPlugin(fakeManifest("dev.bad", { main: "main.js" }), dom);

    await expect(plugin.activate(host.ctx)).rejects.toThrow("guest exploded");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("a realm whose document never loads fails by the open timeout", async () => {
    const host = createFakeHost();
    // openRealm never resolves — a wedged kdplugin:// read / a swallowed nav.
    const dom: RealmDom = { openRealm: () => new Promise(() => {}) };
    const plugin = makeExternalPlugin(
      fakeManifest("dev.wedged", { main: "main.js" }),
      dom,
      30,
    );
    await expect(plugin.activate(host.ctx)).rejects.toThrow(
      "document did not load within 30ms",
    );
  });

  it("a realm that never connects fails by timeout and closes", async () => {
    const host = createFakeHost();
    const { dom, close } = fakeRealm(); // no guest: the port dangles
    const plugin = makeExternalPlugin(fakeManifest("dev.hung", { main: "main.js" }), dom, 30);

    await expect(plugin.activate(host.ctx)).rejects.toThrow(
      "did not activate within 30ms",
    );
    expect(close).toHaveBeenCalledTimes(1);
  });
});
