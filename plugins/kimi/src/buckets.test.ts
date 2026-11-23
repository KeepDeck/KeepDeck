import { describe, expect, it } from "vitest";
import { isSessionBucket } from "./buckets";

describe("isSessionBucket", () => {
  it("takes a TUI directory's wd_ bucket and an app-made workspace's wm_ bucket", () => {
    expect(isSessionBucket("wd_kd-keepdeck-11_4b58169be525")).toBe(true);
    expect(isSessionBucket("wm_0b9d5c1e-2f4a-4c55-9a51-2a8f0f6f1c11")).toBe(true);
  });

  it("refuses kimi's own dot entries and anything else", () => {
    for (const name of [".index-cache", ".index-dirty", "session_1", "wx_a", "wd", "Wd_a"]) {
      expect(isSessionBucket(name), name).toBe(false);
    }
  });
});
