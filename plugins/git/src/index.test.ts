import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@keepdeck/plugin-api";
import plugin from "./index";

/**
 * The manifest is the registration gate: the host refuses any contribution
 * the manifest does not declare (`declared()` in the plugin host throws, and
 * activation lands the whole plugin `failed`). Nothing else in this plugin's
 * tests goes through that gate — components are mounted directly — so a
 * declaration that drifts from what `activate` registers would only surface
 * by the Git tab vanishing from a running app.
 */
const manifest = JSON.parse(
  readFileSync(join("plugins/git/manifest.json"), "utf8"),
) as {
  contributes: Record<string, Array<{ id: string }> | boolean | undefined>;
};

function declaredIds(kind: string): string[] {
  const list = manifest.contributes[kind];
  return Array.isArray(list) ? list.map((entry) => entry.id) : [];
}

/** Activate against a context that RECORDS what each surface registers. */
function activateAndRecord() {
  const registered: Record<string, string[]> = { dockTabs: [], overlays: [] };
  const ctx = {
    services: {
      git: {},
      fs: {},
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ui: {
      registerDockTab: (tab: { id: string }) => {
        registered.dockTabs.push(tab.id);
        return { dispose: vi.fn() };
      },
      registerOverlay: (overlay: { id: string }) => {
        registered.overlays.push(overlay.id);
        return { dispose: vi.fn() };
      },
    },
  } as unknown as PluginContext;

  plugin.activate(ctx);
  return registered;
}

describe("git plugin manifest", () => {
  it("declares every surface activation registers", () => {
    const registered = activateAndRecord();
    plugin.deactivate?.();

    // Registering an undeclared id throws in the host and fails the plugin.
    for (const kind of ["dockTabs", "overlays"]) {
      for (const id of registered[kind]) {
        expect(declaredIds(kind), `${kind} "${id}" is not in manifest.json`)
          .toContain(id);
      }
    }
  });

  it("registers the diff as a resident overlay, not as part of the tab", () => {
    const registered = activateAndRecord();
    plugin.deactivate?.();

    // The peek must outlive the dock: a tab body is hidden on a tab switch
    // and unmounted when the dock closes, and the diff belongs to neither.
    expect(registered.overlays).toContain("diff");
    expect(registered.dockTabs).toEqual(["git"]);
  });

  it("declares nothing it never registers", () => {
    const registered = activateAndRecord();
    plugin.deactivate?.();

    for (const kind of ["dockTabs", "overlays"]) {
      expect(declaredIds(kind).sort()).toEqual(registered[kind].sort());
    }
  });
});
