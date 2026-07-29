import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { readManifest } from "@keepdeck/plugin-api";
import type { PluginContext } from "@keepdeck/plugin-api";
import { requestPeek, takePeekRequest } from "./peekRequests";
import { gitStatusSnapshot, subscribeGitStatus } from "./gitStatusFeed";
import plugin from "./index";

/**
 * The manifest is the registration gate: the host refuses any contribution
 * the manifest does not declare (`declared()` in the plugin host throws, and
 * activation lands the whole plugin `failed`). Nothing else in this plugin's
 * tests goes through that gate — components are mounted directly — so a
 * declaration that drifts from what `activate` registers would only surface
 * by the Git tab vanishing from a running app.
 *
 * The manifest is read through the host's own `readManifest`, not a raw
 * `JSON.parse`. The validator DROPS an entry missing a label or carrying an
 * id outside the allowed characters, which is exactly the shape that then
 * fails `declared()` — parsing the file ourselves would call such a manifest
 * fine while the running host refused the plugin.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const parsed = readManifest(
  JSON.parse(readFileSync(join(HERE, "..", "manifest.json"), "utf8")),
);

function declaredIds(kind: "dockTabs" | "overlays"): string[] {
  if (!parsed.ok) return [];
  return (parsed.manifest.contributes[kind] ?? []).map((entry) => entry.id);
}

/** Activate against a context that RECORDS what each surface registers. */
function activateAndRecord() {
  const registered: Record<string, string[]> = { dockTabs: [], overlays: [] };
  const ctx = {
    services: {
      git: {
        status: vi.fn(async (repo: string) => ({
          branch: "main",
          detached: false,
          oid: repo,
          upstream: null,
          ahead: null,
          behind: null,
          entries: [],
        })),
        watch: vi.fn(() => ({ dispose: vi.fn() })),
      },
      fs: {},
    },
    events: {
      onPaneSelected: () => ({ dispose: vi.fn() }),
      onWorkspaceClosed: () => ({ dispose: vi.fn() }),
      onDeckChanged: () => ({ dispose: vi.fn() }),
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
  it("passes the host's own validator", () => {
    // A manifest the validator rejects never reaches `declared()` at all —
    // the plugin fails to load, and every parity check below would be
    // comparing against an empty list without saying so.
    expect(parsed.ok, parsed.ok ? "" : parsed.errors.join("; ")).toBe(true);
  });

  it("declares exactly the surfaces activation registers, and no others", () => {
    const registered = activateAndRecord();
    plugin.deactivate?.();

    // Both directions: registering an undeclared id throws in the host and
    // fails the plugin, while a declaration nobody registers is a dead
    // promise to the user about what this plugin contributes.
    for (const kind of ["dockTabs", "overlays"] as const) {
      expect(declaredIds(kind).sort()).toEqual(registered[kind].sort());
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
});

describe("git plugin deactivate", () => {
  it("leaves a subscribed status feed standing — the host unmounts its surfaces after this", async () => {
    activateAndRecord();
    const stop = subscribeGitStatus("/repo", vi.fn());
    await Promise.resolve();
    await Promise.resolve();
    const before = gitStatusSnapshot("/repo");
    expect(before.status?.oid).toBe("/repo");

    plugin.deactivate?.();

    // Closing here reached past a still-mounted surface: the host runs
    // `deactivate` BEFORE disposing the contributions that unmount them, so a
    // closed feed answered the unknown-repo default and rewound `version`,
    // re-running every read keyed on it against a runtime just set to null.
    expect(gitStatusSnapshot("/repo")).toBe(before);
    stop();
    // The last subscriber leaving is what disposes it, in production too.
    expect(gitStatusSnapshot("/repo").version).toBe(0);
  });

  it("drains a parked request — the next activation never replays a stale peek", () => {
    activateAndRecord();
    requestPeek({
      repo: "/repo",
      workspace: { id: "ws-1", instance: "instance-1" },
      kind: "worktree",
      row: { path: "a.ts", origPath: null, code: "M", kind: "unstaged" },
    });

    plugin.deactivate?.();

    expect(takePeekRequest()).toBeNull();
  });
});
