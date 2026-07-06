import { describe, expect, it } from "vitest";
import type { SettingsSectionContribution } from "@keepdeck/plugin-api";
import { mergeSectionValues } from "./pluginSettingsValues";

const section: SettingsSectionContribution = {
  label: "Sample",
  fields: [
    { kind: "boolean", key: "greet", label: "Greet", default: true },
    { kind: "string", key: "note", label: "Note", default: "" },
    { kind: "number", key: "port", label: "Port", default: 3000 },
    {
      kind: "select",
      key: "mode",
      label: "Mode",
      default: "auto",
      options: [
        { value: "auto", label: "Auto" },
        { value: "manual", label: "Manual" },
      ],
    },
  ],
};

describe("mergeSectionValues", () => {
  it("yields pure defaults when nothing is stored", () => {
    expect(mergeSectionValues(section, undefined)).toEqual({
      greet: true,
      note: "",
      port: 3000,
      mode: "auto",
    });
  });

  it("stored values of the right shape win over defaults", () => {
    expect(
      mergeSectionValues(section, { greet: false, note: "x", port: 8080 }),
    ).toMatchObject({ greet: false, note: "x", port: 8080 });
  });

  it("wrong-shaped stored values fall back per field (hand-edited file)", () => {
    expect(
      mergeSectionValues(section, {
        greet: "yes",
        note: 5,
        port: "eighty",
        mode: "bogus",
      }),
    ).toEqual({ greet: true, note: "", port: 3000, mode: "auto" });
  });

  it("select accepts only a declared option", () => {
    expect(mergeSectionValues(section, { mode: "manual" }).mode).toBe(
      "manual",
    );
  });

  it("keys the section does not declare never come through", () => {
    expect(
      mergeSectionValues(section, { stale: "value" }),
    ).not.toHaveProperty("stale");
  });

  it("no registered section means no values", () => {
    expect(mergeSectionValues(undefined, { note: "x" })).toEqual({});
  });
});
