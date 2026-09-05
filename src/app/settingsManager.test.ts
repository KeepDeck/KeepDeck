import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_VERSION } from "../domain/settings";
import { createSettingsManager, type SettingsPorts } from "./settingsManager";

vi.mock("../ipc/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  describeError: (e: unknown) => String(e),
}));

/**
 * Built through the factory with fakes — no module mocking, no shared state to
 * reset between cases. That is the point of the factory: the "did I remember to
 * clear field N" class of test bug cannot exist here.
 */
function managerOver(overrides: Partial<SettingsPorts> = {}) {
  const ports = {
    loadSettings: vi.fn<() => Promise<string | null>>(() => Promise.resolve(null)),
    saveSettings: vi.fn<(json: string) => Promise<void>>(() => Promise.resolve()),
    quarantineSettings: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    snapshotSettings: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  };
  // Assigned rather than spread so `ports` keeps its mock types for assertions.
  Object.assign(ports, overrides);
  return { manager: createSettingsManager(ports), ports };
}

const stored = (settings: Record<string, unknown>) =>
  JSON.stringify({ version: SETTINGS_VERSION, ...settings });

const savedBy = (calls: [string][]) =>
  calls.map(([json]) => JSON.parse(json) as Record<string, unknown>);

describe("reading the stored document", () => {
  it("is null until the load settles — the paint gate", async () => {
    let resolveLoad!: (json: string | null) => void;
    const { manager } = managerOver({
      loadSettings: vi.fn(
        () => new Promise<string | null>((resolve) => (resolveLoad = resolve)),
      ),
    });
    const booted = manager.init();
    expect(manager.get()).toBeNull();

    resolveLoad(null);
    await booted;
    expect(manager.get()).toEqual(DEFAULT_SETTINGS);
  });

  it("repeated init shares one load", async () => {
    const { manager, ports } = managerOver();
    await Promise.all([manager.init(), manager.init()]);
    expect(ports.loadSettings).toHaveBeenCalledTimes(1);
  });

  it("exposes the stored values, and loading alone never writes", async () => {
    const { manager, ports } = managerOver({
      loadSettings: vi.fn(() => Promise.resolve(stored({ scrollback: 30_000 }))),
    });
    await manager.init();
    expect(manager.get()).toEqual({ ...DEFAULT_SETTINGS, scrollback: 30_000 });
    expect(ports.saveSettings).not.toHaveBeenCalled();
  });

  it("retries once when the load rejects, and adopts the second answer", async () => {
    // The failures that produce a rejected read are usually momentary, and
    // giving up costs the whole session its ability to save.
    const loadSettings = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error("EMFILE"))
      .mockResolvedValueOnce(stored({ remoteAgents: true }));
    const { manager } = managerOver({ loadSettings });

    await manager.init();

    expect(loadSettings).toHaveBeenCalledTimes(2);
    expect(manager.get()?.remoteAgents).toBe(true);
  });

  it("quarantines an unusable file, waits for it, then starts from defaults", async () => {
    const { manager, ports } = managerOver({
      loadSettings: vi.fn(() => Promise.resolve("{typo")),
    });
    await manager.init();
    expect(ports.quarantineSettings).toHaveBeenCalledTimes(1);
    expect(manager.get()).toEqual(DEFAULT_SETTINGS);

    // The evidence is preserved, so the slot is genuinely free: writing is fine.
    manager.update({ scrollback: 20_000 });
    await manager.flush();
    expect(savedBy(ports.saveSettings.mock.calls)[0].scrollback).toBe(20_000);
  });
});

describe("a file we could not read is never overwritten", () => {
  it("refuses to save for the rest of the session when the load keeps failing", async () => {
    // Writing our defaults over a file we cannot see IS the "my settings reset"
    // report. The change still applies in memory so the app stays usable.
    const { manager, ports } = managerOver({
      loadSettings: vi.fn(() => Promise.reject(new Error("EACCES"))),
    });
    await manager.init();

    manager.update({ scrollback: 20_000 });
    await manager.flush();

    expect(manager.get()?.scrollback).toBe(20_000); // applied
    expect(ports.saveSettings).not.toHaveBeenCalled(); // but never written
    // And it stays refused — a later change must not sneak past either.
    manager.update({ remoteAgents: true });
    await manager.flush();
    expect(ports.saveSettings).not.toHaveBeenCalled();
  });

  it("refuses to save when the quarantine of an unusable file failed", async () => {
    // A quarantine that did not land leaves the original in place, so the file
    // is still there to be destroyed.
    const { manager, ports } = managerOver({
      loadSettings: vi.fn(() => Promise.resolve("{typo")),
      quarantineSettings: vi.fn(() => Promise.reject(new Error("read-only fs"))),
    });
    await manager.init();

    manager.update({ scrollback: 20_000 });
    await manager.flush();

    expect(ports.saveSettings).not.toHaveBeenCalled();
  });

  it("an absent file IS a confirmed answer, so a first run saves normally", async () => {
    // `null` means NotFound and nothing else, so there is nothing to destroy.
    const { manager, ports } = managerOver();
    await manager.init();

    manager.update({ scrollback: 20_000 });
    await manager.flush();

    expect(savedBy(ports.saveSettings.mock.calls)[0]).toEqual({
      version: SETTINGS_VERSION,
      minVersion: 1,
      scrollback: 20_000,
    });
  });
});

describe("writing", () => {
  it("update applies at once and writes the chosen keys through", async () => {
    const { manager, ports } = managerOver();
    await manager.init();

    manager.update({ defaultAgent: "opencode" });
    expect(manager.get()?.defaultAgent).toBe("opencode");
    await manager.flush();
    expect(savedBy(ports.saveSettings.mock.calls)).toEqual([
      { version: SETTINGS_VERSION, minVersion: 1, defaultAgent: "opencode" },
    ]);
  });

  it("update before the load settles is a no-op", () => {
    const { manager, ports } = managerOver({
      loadSettings: vi.fn(() => new Promise<string | null>(() => {})),
    });
    void manager.init();
    manager.update({ scrollback: 20_000 });
    expect(manager.get()).toBeNull();
    expect(ports.saveSettings).not.toHaveBeenCalled();
  });

  it("same-tick updates chain, and the last write carries both", async () => {
    const { manager, ports } = managerOver();
    await manager.init();

    manager.update({ scrollback: 20_000 });
    manager.update({ defaultAgent: "codex" });
    await manager.flush();

    const writes = savedBy(ports.saveSettings.mock.calls);
    expect(writes[writes.length - 1]).toEqual({
      version: SETTINGS_VERSION,
      minVersion: 1,
      scrollback: 20_000,
      defaultAgent: "codex",
    });
  });

  it("a failed save doesn't wedge the chain — the next change still writes", async () => {
    // A rejection left on the chain would make every later `.then` skip its
    // callback, and settings would stop persisting for the session in silence.
    const saveSettings = vi
      .fn<(json: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    const { manager, ports } = managerOver({ saveSettings });
    await manager.init();

    manager.update({ scrollback: 20_000 });
    await manager.flush();
    manager.update({ scrollback: 25_000 });
    await manager.flush();

    expect(saveSettings).toHaveBeenCalledTimes(2);
    expect(savedBy(ports.saveSettings.mock.calls)[1].scrollback).toBe(25_000);
  });

  it("preserves a stored unknown key across an update", async () => {
    const { manager, ports } = managerOver({
      loadSettings: vi.fn(() => Promise.resolve(stored({ futureToggle: true }))),
    });
    await manager.init();

    manager.update({ scrollback: 20_000 });
    await manager.flush();
    expect(savedBy(ports.saveSettings.mock.calls)[0].futureToggle).toBe(true);
  });

  it("keeps a stored value the user chose at today's default", async () => {
    const { manager, ports } = managerOver({
      loadSettings: vi.fn(() => Promise.resolve(stored({ remoteAgents: false }))),
    });
    await manager.init();

    manager.update({ scrollback: 20_000 });
    await manager.flush();
    expect(savedBy(ports.saveSettings.mock.calls)[0].remoteAgents).toBe(false);
  });

  it("notifies subscribers on load and on update; unsubscribing stops", async () => {
    const { manager } = managerOver();
    const seen: (number | undefined)[] = [];
    const unsubscribe = manager.subscribe(() => seen.push(manager.get()?.scrollback));

    await manager.init();
    manager.update({ scrollback: 20_000 });
    expect(seen).toEqual([DEFAULT_SETTINGS.scrollback, 20_000]);

    unsubscribe();
    manager.update({ scrollback: 25_000 });
    expect(seen).toHaveLength(2);
  });
});

describe("the pre-update snapshot", () => {
  it("waits for a queued write, so it copies what the user actually has", async () => {
    // A copy taken mid-write preserves the document being replaced, which is
    // the one state a restore point must not hold.
    const order: string[] = [];
    let releaseSave!: () => void;
    const { manager } = managerOver({
      saveSettings: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseSave = () => {
              order.push("save");
              resolve();
            };
          }),
      ),
      snapshotSettings: vi.fn(async () => {
        order.push("snapshot");
      }),
    });
    await manager.init();

    manager.update({ scrollback: 20_000 });
    // Let the queued step reach the save port (the chain hands off in a
    // microtask), so the snapshot really does queue behind an IN-FLIGHT write.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const snapshotting = manager.snapshot();
    releaseSave();
    await snapshotting;

    expect(order).toEqual(["save", "snapshot"]);
  });

  it("still copies when there is nothing queued", async () => {
    const { manager, ports } = managerOver();
    await manager.init();
    await manager.snapshot();
    expect(ports.snapshotSettings).toHaveBeenCalledTimes(1);
  });
});
