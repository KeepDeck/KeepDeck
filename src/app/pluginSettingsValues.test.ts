import { describe, expect, it } from "vitest";
import type { SettingsSectionContribution } from "@keepdeck/plugin-api";
import { undeclaredStoredKeys } from "./pluginSettingsValues";

const section = (...keys: string[]): SettingsSectionContribution => ({
  label: "Voice",
  fields: keys.map((key) => ({
    kind: "string" as const,
    key,
    label: key,
    default: "",
  })),
});

describe("undeclaredStoredKeys", () => {
  it("names a stored key whose field the section never declares", () => {
    // The voice drift verbatim: written and read as "model", declared "models".
    expect(undeclaredStoredKeys(section("hotkeys", "models"), { model: "big" })).toEqual([
      "model",
    ]);
  });

  it("is empty when every stored key has a field", () => {
    expect(
      undeclaredStoredKeys(section("hotkeys", "model"), { model: "big", hotkeys: {} }),
    ).toEqual([]);
  });

  it("is empty for a plugin that has stored nothing yet", () => {
    expect(undeclaredStoredKeys(section("model"), undefined)).toEqual([]);
    expect(undeclaredStoredKeys(section("model"), {})).toEqual([]);
  });

  it("names every stray key, not just the first", () => {
    expect(
      undeclaredStoredKeys(section("model"), { model: "big", gone: 1, alsoGone: 2 }),
    ).toEqual(["gone", "alsoGone"]);
  });

  it("declares nothing, so everything stored is stray", () => {
    expect(undeclaredStoredKeys(section(), { model: "big" })).toEqual(["model"]);
  });
});
