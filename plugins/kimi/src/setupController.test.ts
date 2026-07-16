import { describe, expect, it, vi } from "vitest";
import type { PluginLogger } from "@keepdeck/plugin-api";
import { COMPANION_VERSION } from "./companion";
import type { KimiCompanionManager } from "./manager";
import {
  createKimiSetupController,
  stateFromInstallation,
} from "./setupController";

function harness(
  inspectResults: Array<
    Awaited<ReturnType<KimiCompanionManager["inspect"]>>
  >,
) {
  const next = () => inspectResults.shift() ?? null;
  const inspect = vi.fn(async () => next());
  const configure = vi.fn(async () => {
    const installation = next();
    if (!installation) throw new Error("missing configured result");
    return installation;
  });
  const manager: KimiCompanionManager = {
    inspect,
    configure,
    remove: vi.fn(async () => next()),
    dispose: vi.fn(async () => {}),
  };
  const log: PluginLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    controller: createKimiSetupController(manager, "/App/reporter", log),
    manager,
    inspect,
    log,
  };
}

describe("Kimi setup state", () => {
  it("derives explicit states from Kimi's real installation", () => {
    expect(stateFromInstallation(null)).toEqual({
      kind: "not-configured",
      operation: null,
    });
    expect(
      stateFromInstallation({
        version: COMPANION_VERSION,
        enabled: true,
        healthy: true,
        owned: true,
      }),
    ).toEqual({
      kind: "configured",
      operation: null,
      version: COMPANION_VERSION,
    });
    expect(
      stateFromInstallation({
        version: COMPANION_VERSION,
        enabled: false,
        healthy: true,
        owned: true,
      }),
    ).toMatchObject({ kind: "needs-attention", reason: "disabled" });
    expect(
      stateFromInstallation({
        version: "0.9.0",
        enabled: true,
        healthy: true,
        owned: true,
      }),
    ).toMatchObject({ kind: "needs-attention", reason: "outdated" });
    expect(
      stateFromInstallation({
        version: COMPANION_VERSION,
        enabled: true,
        healthy: true,
        owned: false,
      }),
    ).toMatchObject({ kind: "needs-attention", reason: "collision" });
  });

  it("re-checks Kimi after configure and remove", async () => {
    const healthy = {
      version: COMPANION_VERSION,
      enabled: true,
      healthy: true,
      owned: true,
    };
    const configured = harness([healthy]);
    await configured.controller.configure();
    expect(configured.manager.configure).toHaveBeenCalledWith("/App/reporter");
    expect(configured.inspect).not.toHaveBeenCalled();
    expect(configured.controller.snapshot()).toMatchObject({
      kind: "configured",
      runningSessionsNeedReload: true,
    });

    const removed = harness([null]);
    await removed.controller.remove();
    expect(removed.manager.remove).toHaveBeenCalledWith();
    expect(removed.inspect).not.toHaveBeenCalled();
    expect(removed.controller.snapshot()).toMatchObject({
      kind: "not-configured",
      runningSessionsNeedReload: true,
    });
  });

  it("exposes check failures without pretending setup is absent", async () => {
    const { controller, manager, log } = harness([]);
    vi.mocked(manager.inspect).mockRejectedValueOnce(new Error("kimi not found"));

    await expect(controller.check()).resolves.toEqual({
      kind: "error",
      operation: null,
      message: "kimi not found",
      failedOperation: "check",
    });
    expect(log.warn).toHaveBeenCalledWith(
      "Kimi setup check failed: kimi not found",
    );
  });

  it("preserves the failed operation so Remove can be retried", async () => {
    const { controller, manager } = harness([]);
    vi.mocked(manager.remove).mockRejectedValueOnce(new Error("temporary"));

    await controller.remove();

    expect(controller.snapshot()).toEqual({
      kind: "error",
      operation: null,
      message: "temporary",
      failedOperation: "remove",
    });
  });
});
