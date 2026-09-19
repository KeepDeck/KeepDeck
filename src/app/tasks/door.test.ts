import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../../domain/settings";
import { tasksDoorOpen } from "./door";

const settings = (tasks: boolean): Settings => ({ ...DEFAULT_SETTINGS, tasks });

describe("tasksDoorOpen", () => {
  it("offers the door only for a setting that says so, and nothing before the settings load", () => {
    expect(tasksDoorOpen(settings(true))).toBe(true);
    expect(tasksDoorOpen(settings(false))).toBe(false);
    expect(tasksDoorOpen(null)).toBe(false);
  });
});
