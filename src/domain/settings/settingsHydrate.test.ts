import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  SCROLLBACK_MAX,
  SCROLLBACK_MIN,
  hydrateSettings,
  serializeSettings,
} from ".";
import { restore } from "./settings.testSupport";

/** Per-key tolerant reading of a stored settings document. */

describe("hydrateSettings", () => {
  it("an empty object yields pure defaults and no decisions", () => {
    const doc = restore("{}");
    expect(doc.settings).toEqual(DEFAULT_SETTINGS);
    expect(doc.chosen).toEqual({});
    expect(doc.extras).toEqual({});
  });

  it("rejects only what isn't a JSON object — the quarantine cases", () => {
    expect(hydrateSettings("{corrupt")).toBeNull();
    expect(hydrateSettings("null")).toBeNull();
    expect(hydrateSettings('"a string"')).toBeNull();
    expect(hydrateSettings("[1,2]")).toBeNull();
  });

  it("quarantines a document whose floor is above this build", () => {
    expect(
      hydrateSettings(JSON.stringify({ version: 99, minVersion: 99, scrollback: 1 })),
    ).toBeNull();
  });

  it("reads every recognized key, and records each as chosen", () => {
    const stored = {
      version: 1,
      defaultAgent: "codex",
      defaultYolo: true,
      scrollback: 50_000,
      suspendedAgentPlacement: "tray",
      dockMode: "floating",
      plugins: {
        enabled: { git: true },
        values: { git: { remote: "origin" } },
      },
      notifications: { enabled: false, mode: "system" },
      usageDisplay: "left",
      parkAgentsOnLaunch: true,
      agentTeams: true,
    };
    const doc = restore(JSON.stringify(stored));
    expect(doc.settings).toEqual({
      defaultAgent: "codex",
      defaultYolo: true,
      scrollback: 50_000,
      suspendedAgentPlacement: "tray",
      dockMode: "floating",
      plugins: { enabled: { git: true }, values: { git: { remote: "origin" } }, consented: {} },
      notifications: { enabled: false, mode: "system", mutedPlugins: [] },
      usageDisplay: "left",
      remoteAgents: false,
      parkAgentsOnLaunch: true,
      agentTeams: true,
      artifacts: false,
      artifactAutoOpen: true,
    });
    // Everything the file said is a decision; `remoteAgents`, `artifacts`
    // and `artifactAutoOpen`, which it did not mention, are not.
    expect(Object.keys(doc.chosen).sort()).toEqual(
      Object.keys(stored)
        .filter((key) => key !== "version")
        .sort(),
    );
  });

  it("a malformed value degrades ONLY its own key", () => {
    // The file is hand-editable: one typo must not reset the other settings.
    const doc = restore(JSON.stringify({ defaultAgent: 7, scrollback: 50_000 }));
    expect(doc.settings).toEqual({ ...DEFAULT_SETTINGS, scrollback: 50_000 });
    // And the unusable key is NOT a decision — re-writing it as a synthesized
    // default would grow the file while recording nothing.
    expect(doc.chosen).toEqual({ scrollback: 50_000 });
  });

  it("keeps an unknown defaultAgent id — the id set is open", () => {
    // Agents come from plugins; hydration cannot know the catalog. An absent
    // plugin's id just loses the picker vote (defaultAgentType snaps away).
    expect(restore('{"defaultAgent":"gemini"}').settings.defaultAgent).toBe("gemini");
  });

  it("a null defaultAgent (older document) degrades to the default", () => {
    expect(restore('{"defaultAgent":null}').settings.defaultAgent).toBe(
      DEFAULT_SETTINGS.defaultAgent,
    );
  });

  it("clamps scrollback into bounds and whole lines", () => {
    const at = (scrollback: unknown) =>
      restore(JSON.stringify({ scrollback })).settings.scrollback;
    expect(at(5)).toBe(SCROLLBACK_MIN);
    expect(at(1e9)).toBe(SCROLLBACK_MAX);
    expect(at(2000.7)).toBe(2001);
    // Not even a finite number → the default, not a clamp of garbage.
    expect(at("many")).toBe(DEFAULT_SETTINGS.scrollback);
    expect(at(Number.NaN)).toBe(DEFAULT_SETTINGS.scrollback);
  });

  it("accepts tray placement for suspended agents and rejects malformed values", () => {
    expect(
      restore('{"suspendedAgentPlacement":"tray"}').settings.suspendedAgentPlacement,
    ).toBe("tray");
    for (const bad of ["strip", "hidden", true, 1]) {
      expect(
        restore(JSON.stringify({ suspendedAgentPlacement: bad })).settings
          .suspendedAgentPlacement,
      ).toBe("pane");
    }
  });

  it("accepts each known dockMode, and falls back to docked otherwise", () => {
    for (const mode of ["docked", "floating"]) {
      expect(restore(JSON.stringify({ dockMode: mode })).settings.dockMode).toBe(mode);
    }
    // Absent, misspelled, or the wrong type — each lands on the mode the dock
    // had before the setting existed, without touching its neighbours.
    for (const bad of [undefined, "float", "right", true, 1]) {
      expect(restore(JSON.stringify({ dockMode: bad })).settings.dockMode).toBe("docked");
    }
  });

  it("snaps a malformed usageDisplay back to the default", () => {
    expect(restore('{"usageDisplay":"sideways"}').settings.usageDisplay).toBe("used");
  });

  it("reads the booleans and refuses a non-boolean, whichever way it points", () => {
    // Asserting `false` against a file that says `"yes"` proves nothing on its
    // own — `false` is the default, so deleting the reader outright would leave
    // it green. Each key is driven ON first, then corrupted.
    for (const key of ["defaultYolo", "remoteAgents", "parkAgentsOnLaunch", "agentTeams"]) {
      expect(restore(JSON.stringify({ [key]: true })).settings).toMatchObject({
        [key]: true,
      });
      for (const bad of ["yes", 1, null]) {
        expect(restore(JSON.stringify({ [key]: bad })).settings).toMatchObject({
          [key]: false,
        });
      }
    }
  });

  it("preserves unknown keys, including a stored __proto__", () => {
    // Hand edits and keys written by a newer build must survive our saves. The
    // `__proto__` case is the one that used to vanish: assigning it into an
    // ordinary object hits Object.prototype's setter and creates no own key, so
    // the next save dropped it. Written as raw JSON on purpose — in an object
    // LITERAL `__proto__:` sets the prototype and never becomes a key at all.
    const doc = restore('{"version":1,"futureToggle":{"nested":true},"__proto__":{"a":1}}');
    expect(doc.extras).toMatchObject({ futureToggle: { nested: true } });
    expect(Object.keys(doc.extras)).toContain("__proto__");
    // And it survives the save, which is the promise being kept.
    expect(serializeSettings(doc)).toContain('"__proto__"');
  });
});

describe("hydrateSettings — the plugins bag", () => {
  it("defaults to empty maps when the field is absent, and chooses nothing", () => {
    const doc = restore("{}");
    expect(doc.settings.plugins).toEqual({ enabled: {}, values: {}, consented: {} });
    expect(doc.chosen.plugins).toBeUndefined();
  });

  it("reads enabled flags and per-plugin values verbatim", () => {
    const doc = restore(
      JSON.stringify({
        plugins: {
          enabled: { git: true, notes: false },
          values: { git: { remote: "origin", depth: 3 } },
        },
      }),
    );
    expect(doc.settings.plugins).toEqual({
      enabled: { git: true, notes: false },
      values: { git: { remote: "origin", depth: 3 } },
      consented: {},
    });
  });

  it("a malformed entry degrades on its own, keeping its siblings", () => {
    // The file is hand-editable: one bad plugin id must not wipe the rest.
    const doc = restore(
      JSON.stringify({
        plugins: {
          enabled: { git: true, bad: "not a bool" },
          values: { git: { x: 1 }, bad: "not an object" },
        },
      }),
    );
    expect(doc.settings.plugins).toEqual({
      enabled: { git: true },
      values: { git: { x: 1 } },
      consented: {},
    });
  });

  it("a non-record plugins field degrades to defaults instead of rejecting the document", () => {
    const doc = restore(JSON.stringify({ plugins: "not an object", scrollback: 20_000 }));
    expect(doc.settings.plugins).toEqual({ enabled: {}, values: {}, consented: {} });
    expect(doc.settings.scrollback).toBe(20_000); // rest of the doc survives
    expect(doc.chosen.plugins).toBeUndefined(); // and it chose nothing
  });

  it("an ALL-EMPTY bag the file carried is still a decision", () => {
    // It used to read as a failure, so the key was dropped on the next save —
    // the same erasure this document model exists to prevent.
    const doc = restore('{"plugins":{"enabled":{},"values":{},"consented":{}}}');
    expect(doc.chosen.plugins).toEqual({ enabled: {}, values: {}, consented: {} });
  });

  it("v5 graduation: an explicit experimentRunPresets=false disables the Run plugin", () => {
    const doc = restore(JSON.stringify({ experimentRunPresets: false }));
    expect(doc.settings.plugins.enabled["keepdeck.run"]).toBe(false);
    // Consumed, not an extra: the retired key must not be rewritten forever.
    expect(doc.extras).toEqual({});
    // And the mapping is a DECISION, so it does not depend on the written value
    // merely differing from the default to survive.
    expect(doc.chosen.plugins?.enabled["keepdeck.run"]).toBe(false);
  });

  it("v5 graduation: a stored true enables the Run plugin (preserves prior state)", () => {
    // Plugins default OFF, so an experiment-ON user's Run must be carried
    // over explicitly or it would vanish.
    expect(
      restore(JSON.stringify({ experimentRunPresets: true })).settings.plugins.enabled[
        "keepdeck.run"
      ],
    ).toBe(true);
  });

  // A retired key is CONSUMED, whatever it said: neither a decision nor an
  // extra (an extra would be rewritten forever), and not a degradation either
  // — the file said nothing wrong, it said something nobody asks any more.
  for (const [key, values] of [
    // v18: the MCP transport lost its switch.
    ["mcpServer", [true, false, "yes"]],
    // v19: the tray became the only shape for a minimized agent.
    ["minimizeStyle", ["tray", "strip", "none", "mosaic"]],
    // v20: the grid became the only deck layout.
    ["deckLayout", ["grid", "list", "spiral"]],
  ] as const) {
    it(`retired ${key} is consumed, whatever it said`, () => {
      for (const value of values) {
        const hydrated = hydrateSettings(JSON.stringify({ [key]: value }));
        expect(hydrated).not.toBeNull();
        expect(hydrated!.doc.chosen).toEqual({});
        expect(hydrated!.doc.extras).toEqual({});
        expect(hydrated!.provenance.degraded).toEqual([]);
      }
    });
  }

  it("v5 graduation: an absent flag leaves the Run plugin unset (default off)", () => {
    expect(restore("{}").settings.plugins.enabled["keepdeck.run"]).toBeUndefined();
  });

  it("v5 graduation: an explicit plugins.enabled entry outranks the retired flag", () => {
    const doc = restore(
      JSON.stringify({
        experimentRunPresets: false,
        plugins: { enabled: { "keepdeck.run": true } },
      }),
    );
    expect(doc.settings.plugins.enabled["keepdeck.run"]).toBe(true);
  });

  it("v5 graduation keeps the rest of a stored bag", () => {
    const doc = restore(
      JSON.stringify({
        experimentRunPresets: true,
        plugins: { enabled: { "keepdeck.git": true }, consented: { "acme.x": "fp" } },
      }),
    );
    expect(doc.settings.plugins.enabled).toEqual({
      "keepdeck.git": true,
      "keepdeck.run": true,
    });
    expect(doc.settings.plugins.consented).toEqual({ "acme.x": "fp" });
  });
});

describe("hydrateSettings — the notifications bag", () => {
  it("defaults when the field is absent, and chooses nothing", () => {
    const doc = restore("{}");
    expect(doc.settings.notifications).toEqual(DEFAULT_SETTINGS.notifications);
    expect(doc.chosen.notifications).toBeUndefined();
  });

  it("reads a stored mode and enabled flag", () => {
    expect(
      restore('{"notifications":{"enabled":false,"mode":"app"}}').settings.notifications,
    ).toEqual({ enabled: false, mode: "app", mutedPlugins: [] });
  });

  it("a malformed field degrades alone, keeping its siblings", () => {
    const doc = restore(
      JSON.stringify({
        notifications: {
          enabled: "nope",
          mode: "system",
          mutedPlugins: ["keepdeck.git", 7],
        },
      }),
    );
    expect(doc.settings.notifications).toEqual({
      enabled: true,
      mode: "system",
      mutedPlugins: ["keepdeck.git"],
    });
  });

  it("an unknown mode falls back to the default", () => {
    expect(
      restore('{"notifications":{"mode":"carrier-pigeon"}}').settings.notifications.mode,
    ).toBe("system-and-app");
  });

  it("an ALL-DEFAULT bag the file carried is still a decision", () => {
    // Same erasure as the plugins bag: reading "equal to the default" as
    // "unusable" dropped the key the user's file explicitly held.
    const doc = restore(
      '{"notifications":{"enabled":true,"mode":"system-and-app","mutedPlugins":[]}}',
    );
    expect(doc.chosen.notifications).toEqual(DEFAULT_SETTINGS.notifications);
  });

  it("never aliases the shared default mutedPlugins array", () => {
    const doc = restore('{"notifications":{"mode":"app"}}');
    expect(doc.settings.notifications.mutedPlugins).toEqual([]);
    expect(doc.settings.notifications.mutedPlugins).not.toBe(
      DEFAULT_SETTINGS.notifications.mutedPlugins,
    );
  });
});

describe("the shared default bags are frozen", () => {
  it("refuses an in-place write, so no document can poison the default", () => {
    // A document that chose neither bag shares these very objects; before they
    // were frozen, one stray write would have changed the default for every
    // module that reads it as a fallback, process-wide.
    const shared = restore("{}").settings;
    expect(shared.plugins).toBe(DEFAULT_SETTINGS.plugins);
    expect(() => {
      shared.plugins.enabled["keepdeck.git"] = true;
    }).toThrow();
    expect(() => {
      shared.notifications.mutedPlugins.push("keepdeck.run");
    }).toThrow();
    expect(DEFAULT_SETTINGS.plugins.enabled).toEqual({});
  });
});
