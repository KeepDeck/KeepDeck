import type { PluginLogger } from "@keepdeck/plugin-api";
import { COMPANION_VERSION } from "./companion";
import type {
  KimiCompanionInstallation,
  KimiCompanionManager,
} from "./manager";

export type SetupState =
  | { kind: "checking"; operation: null }
  | {
      kind: "not-configured";
      operation: null;
      runningSessionsNeedReload?: boolean;
    }
  | {
      kind: "configured";
      operation: null;
      version: string;
      runningSessionsNeedReload?: boolean;
    }
  | {
      kind: "needs-attention";
      operation: null;
      version: string | null;
      reason: "disabled" | "invalid" | "outdated" | "collision";
    }
  | {
      kind: "error";
      operation: null;
      message: string;
      failedOperation: "check" | "configure" | "remove";
    }
  | {
      kind: "working";
      operation: "configure" | "remove";
      previous: Exclude<SetupState, { kind: "working" }>;
    };

type StableSetupState = Exclude<SetupState, { kind: "working" }>;

export interface KimiSetupController {
  snapshot(): SetupState;
  subscribe(listener: () => void): () => void;
  check(): Promise<StableSetupState>;
  configure(): Promise<void>;
  remove(): Promise<void>;
  dispose(): Promise<void>;
}

export function createKimiSetupController(
  manager: KimiCompanionManager,
  companionDirectory: string | null,
  log: PluginLogger,
): KimiSetupController {
  let state: SetupState = { kind: "checking", operation: null };
  const listeners = new Set<() => void>();
  let disposed = false;

  const publish = (next: SetupState) => {
    if (disposed) return;
    state = next;
    for (const listener of listeners) listener();
  };

  async function check(): Promise<StableSetupState> {
    publish({ kind: "checking", operation: null });
    try {
      const installation = await manager.inspect();
      const next = stateFromInstallation(installation);
      publish(next);
      return next;
    } catch (caught) {
      const message = describe(caught);
      log.warn(`Kimi setup check failed: ${message}`);
      const next: StableSetupState = {
        kind: "error",
        operation: null,
        message,
        failedOperation: "check",
      };
      publish(next);
      return next;
    }
  }

  async function run(operation: "configure" | "remove"): Promise<void> {
    if (state.kind === "working") return;
    const previous = state;
    publish({ kind: "working", operation, previous });
    try {
      let installation: KimiCompanionInstallation | null;
      if (operation === "configure") {
        if (!companionDirectory) {
          throw new Error("The bundled Kimi setup files are missing.");
        }
        installation = await manager.configure(companionDirectory);
      } else {
        installation = await manager.remove();
      }
      const checked = stateFromInstallation(installation);
      publish(checked);
      // Kimi intentionally applies plugin changes to already-running TUIs
      // only after /reload or /new. /reload is the safe instruction here: it
      // preserves the active conversation and fires SessionStart again, while
      // restarting an unbound pane could lose KeepDeck's route to that session.
      if (operation === "configure" && checked.kind === "configured") {
        publish({ ...checked, runningSessionsNeedReload: true });
      }
      if (operation === "remove" && checked.kind === "not-configured") {
        publish({ ...checked, runningSessionsNeedReload: true });
      }
    } catch (caught) {
      const message = describe(caught);
      log.warn(`Kimi ${operation} failed: ${message}`);
      publish({
        kind: "error",
        operation: null,
        message,
        failedOperation: operation,
      });
    }
  }

  return {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    check,
    configure: () => run("configure"),
    remove: () => run("remove"),
    async dispose() {
      disposed = true;
      listeners.clear();
      await manager.dispose();
    },
  };
}

export function stateFromInstallation(
  installation: KimiCompanionInstallation | null,
): StableSetupState {
  if (!installation) return { kind: "not-configured", operation: null };
  if (!installation.owned) {
    return {
      kind: "needs-attention",
      operation: null,
      version: installation.version,
      reason: "collision",
    };
  }
  if (!installation.enabled) {
    return {
      kind: "needs-attention",
      operation: null,
      version: installation.version,
      reason: "disabled",
    };
  }
  if (!installation.healthy) {
    return {
      kind: "needs-attention",
      operation: null,
      version: installation.version,
      reason: "invalid",
    };
  }
  if (installation.version !== COMPANION_VERSION) {
    return {
      kind: "needs-attention",
      operation: null,
      version: installation.version,
      reason: "outdated",
    };
  }
  return {
    kind: "configured",
    operation: null,
    version: COMPANION_VERSION,
  };
}

function describe(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
