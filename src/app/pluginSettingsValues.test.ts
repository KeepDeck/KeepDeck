import { describe, expect, it, vi } from "vitest";
import type { SettingsSectionContribution } from "@keepdeck/plugin-api";
import { readDeclaredValues } from "./pluginSettingsValues";

const section: SettingsSectionContribution = {
  label: "Voice",
  fields: [{ kind: "string", key: "note", label: "Note", default: "" }],
};

describe("readDeclaredValues", () => {
  it("says so when stored values are dropped for want of a section", () => {
    const warn = vi.fn();

    const values = readDeclaredValues(undefined, { note: "hi" }, warn);

    // The plugin still gets the host's honest answer — the warning is the
    // only thing that separates it from "you have nothing stored".
    expect(values).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/before the section was registered/);
  });

  it("stays quiet on a first run — no section AND nothing stored", () => {
    const warn = vi.fn();

    expect(readDeclaredValues(undefined, undefined, warn)).toEqual({});
    expect(readDeclaredValues(undefined, {}, warn)).toEqual({});

    expect(warn).not.toHaveBeenCalled();
  });

  it("stays quiet once declared, and resolves through the merge", () => {
    const warn = vi.fn();

    // Both a declared value and a stored key the section no longer declares:
    // dropping the latter is intended, so it must not warn.
    const values = readDeclaredValues(section, { note: "hi", gone: 1 }, warn);

    expect(values).toEqual({ note: "hi" });
    expect(warn).not.toHaveBeenCalled();
  });
});
