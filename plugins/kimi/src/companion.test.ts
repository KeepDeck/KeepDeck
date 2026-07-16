import { describe, expect, it } from "vitest";
import { parentDirectory } from "./companion";

describe("Kimi companion resource paths", () => {
  it("derives the installable folder on POSIX and Windows", () => {
    expect(parentDirectory("/App/resources/reporter/kimi.plugin.json")).toBe(
      "/App/resources/reporter",
    );
    expect(parentDirectory("C:\\App\\reporter\\kimi.plugin.json")).toBe(
      "C:\\App\\reporter",
    );
  });

  it("rejects a bare filename", () => {
    expect(parentDirectory("kimi.plugin.json")).toBeNull();
  });
});
