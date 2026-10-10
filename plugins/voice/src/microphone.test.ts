import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHOICE,
  micChoices,
  micPicker,
  MIC_KEY,
  readMicPick,
  standInLine,
  startOptionsFor,
} from "./microphone";

const PM700 = { id: "coreaudio:usb-pm700", name: "BY-PM700", isDefault: true };
const BUILTIN = { id: "coreaudio:BuiltInMicrophoneDevice", name: "MacBook Pro Microphone", isDefault: false };

describe("readMicPick", () => {
  it("reads a stored pick", () => {
    expect(readMicPick({ [MIC_KEY]: { id: BUILTIN.id, name: BUILTIN.name } })).toEqual({
      id: BUILTIN.id,
      name: BUILTIN.name,
    });
  });

  it("treats absent or malformed values as the system default", () => {
    expect(readMicPick({})).toBeNull();
    expect(readMicPick({ [MIC_KEY]: "BY-PM700" })).toBeNull();
    expect(readMicPick({ [MIC_KEY]: { id: "", name: "x" } })).toBeNull();
    expect(readMicPick({ [MIC_KEY]: { id: "a" } })).toBeNull();
  });
});

describe("startOptionsFor", () => {
  it("asks for the picked device by id, or for nothing", () => {
    expect(startOptionsFor({ id: "a", name: "A" })).toEqual({ deviceId: "a" });
    expect(startOptionsFor(null)).toEqual({});
  });
});

describe("micChoices", () => {
  it("lists the default (naming it) and every connected device, the pick selected", () => {
    const rows = micChoices([PM700, BUILTIN], { id: BUILTIN.id, name: BUILTIN.name });
    expect(rows.map((r) => [r.label, r.selected, r.missing])).toEqual([
      ["System default (BY-PM700)", false, false],
      ["BY-PM700", false, false],
      ["MacBook Pro Microphone", true, false],
    ]);
  });

  it("selects the default when nothing is picked", () => {
    expect(micChoices([PM700], null)[0].selected).toBe(true);
  });

  it("keeps an unplugged pick visible, selected and marked — never silently dropped", () => {
    const rows = micChoices([BUILTIN], { id: PM700.id, name: "BY-PM700" });
    expect(rows[rows.length - 1]).toEqual({
      pick: { id: PM700.id, name: "BY-PM700" },
      label: "BY-PM700 — not connected",
      selected: true,
      missing: true,
    });
    expect(rows.filter((r) => r.selected)).toHaveLength(1);
  });
});

describe("micPicker", () => {
  it("keys options by device id, the default by an empty key", () => {
    const picker = micPicker([PM700, BUILTIN], null);
    expect(picker.options.map((o) => o.value)).toEqual([DEFAULT_CHOICE, PM700.id, BUILTIN.id]);
    expect(picker.value).toBe(DEFAULT_CHOICE);
  });

  it("writes back the device's id and name, or null for the default", () => {
    const picker = micPicker([PM700, BUILTIN], null);
    expect(picker.pickOf(BUILTIN.id)).toEqual({ id: BUILTIN.id, name: BUILTIN.name });
    expect(picker.pickOf(DEFAULT_CHOICE)).toBeNull();
  });

  it("keeps an unplugged pick selectable as itself", () => {
    const picker = micPicker([BUILTIN], { id: PM700.id, name: "BY-PM700" });
    expect(picker.value).toBe(PM700.id);
    expect(picker.pickOf(PM700.id)).toEqual({ id: PM700.id, name: "BY-PM700" });
  });
});

describe("standInLine", () => {
  it("names the stand-in when the pick did not record", () => {
    expect(standInLine({ id: PM700.id, name: "BY-PM700" }, "MacBook Pro Microphone")).toBe(
      "Recording from MacBook Pro Microphone — BY-PM700 is not connected",
    );
  });

  it("says nothing when the pick recorded, or nothing was picked", () => {
    expect(standInLine({ id: PM700.id, name: "BY-PM700" }, "BY-PM700")).toBeNull();
    expect(standInLine(null, "BY-PM700")).toBeNull();
    expect(standInLine({ id: PM700.id, name: "BY-PM700" }, null)).toBeNull();
  });
});
