import { describe, expect, it, vi } from "vitest";
import { createFakeHost, fakeManifest } from "./fakeHost";

/**
 * The fake answers `settings.read`/`onChange` the way the host does — every
 * plugin test now leans on that, so the agreement is pinned here rather than
 * rediscovered from a confusing failure in some plugin's suite.
 */
const host = (settingsValues?: Record<string, unknown>) =>
  createFakeHost({ manifest: fakeManifest("keepdeck.sample"), settingsValues });

const field = (key: string) =>
  ({ kind: "string", key, label: key, default: "" }) as const;

describe("fakeHost settings", () => {
  it("answers nothing before a section is declared", async () => {
    const h = host({ mode: "manual" });

    expect(await h.ctx.settings.read()).toEqual({});
  });

  it("answers only the keys the section declares", async () => {
    const h = host({ mode: "manual", stale: "x" });
    h.ctx.settings.registerSection({ label: "S", fields: [field("mode")] });

    expect(await h.ctx.settings.read()).toEqual({ mode: "manual" });
  });

  it("resolves against the LATEST section — a re-registration takes over", async () => {
    const h = host({ mode: "manual", tone: "loud" });
    h.ctx.settings.registerSection({ label: "S", fields: [field("mode")] });
    // What a restart does: the real host retires the first section, so a read
    // must answer from the second, not the one that is already dead.
    h.ctx.settings.registerSection({ label: "S", fields: [field("tone")] });

    expect(await h.ctx.settings.read()).toEqual({ tone: "loud" });
  });

  it("makes a fired change visible to a later read, merged the same way", async () => {
    const h = host({ mode: "manual" });
    h.ctx.settings.registerSection({ label: "S", fields: [field("mode")] });
    const seen = vi.fn();
    h.ctx.settings.onChange(seen);

    h.fire.settingsChanged({ mode: "auto", stale: "x" });

    expect(seen).toHaveBeenCalledWith({ mode: "auto" });
    expect(await h.ctx.settings.read()).toEqual({ mode: "auto" });
  });
});
