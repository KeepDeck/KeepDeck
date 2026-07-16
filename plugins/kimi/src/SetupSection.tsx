import { useSyncExternalStore, type ComponentType } from "react";
import type { CustomSettingsFieldProps } from "@keepdeck/plugin-api";
import { COMPANION_VERSION } from "./companion";
import type { KimiSetupController, SetupState } from "./setupController";

interface SetupPresentation {
  tone: "checking" | "pending" | "ready" | "update" | "error";
  title: string;
  detail: string;
  action: "configure" | "remove" | null;
  actionLabel: string | null;
  busy: boolean;
}

export function setupPresentation(state: SetupState): SetupPresentation {
  if (state.kind === "working") {
    const base = setupPresentation(state.previous);
    return {
      ...base,
      action: state.operation,
      actionLabel: state.operation === "configure" ? "Configuring…" : "Removing…",
      busy: true,
    };
  }
  switch (state.kind) {
    case "checking":
      return {
        tone: "checking",
        title: "Checking setup…",
        detail: "Reading Kimi Code plugin state",
        action: null,
        actionLabel: null,
        busy: true,
      };
    case "not-configured":
      return {
        tone: "pending",
        title: "Not configured",
        detail:
          "Kimi Code needs a one-time setup to restore sessions after KeepDeck restarts. Without it, Kimi still works normally but starts a fresh session after restart.",
        action: "configure",
        actionLabel: "Configure",
        busy: false,
      };
    case "configured":
      return {
        tone: "ready",
        title: "Configured",
        detail: `Session restore is enabled · v${state.version}`,
        action: "remove",
        actionLabel: "Remove",
        busy: false,
      };
    case "needs-attention": {
      const reason =
        state.reason === "disabled"
          ? "The KeepDeck integration is disabled in Kimi Code."
          : state.reason === "invalid"
            ? "The installed KeepDeck integration is not healthy."
            : `Installed ${state.version ? `v${state.version}` : "version is unknown"}; bundled v${COMPANION_VERSION}.`;
      return {
        tone: "update",
        title: state.reason === "outdated" ? "Update required" : "Setup required",
        detail: `${reason} Configure it to restore sessions after KeepDeck restarts.`,
        action: "configure",
        actionLabel: state.reason === "outdated" ? "Update" : "Configure",
        busy: false,
      };
    }
    case "error":
      return {
        tone: "error",
        title: "Setup check failed",
        detail: state.message,
        action: "configure",
        actionLabel: "Configure",
        busy: false,
      };
  }
}

/** Kimi owns both the status and the setup actions. The host merely renders
 * this built-in custom settings field; no Kimi-specific state enters core. */
export function createSetupSection(
  controller: KimiSetupController,
): ComponentType<CustomSettingsFieldProps> {
  function KimiSetupSection() {
    const state = useSyncExternalStore(
      controller.subscribe,
      controller.snapshot,
      controller.snapshot,
    );
    const view = setupPresentation(state);
    const invoke = () => {
      if (view.action === "configure") void controller.configure();
      if (view.action === "remove") void controller.remove();
    };

    return (
      <div className="kimi-setup">
        <div className={`kimi-setup__status kimi-setup__status--${view.tone}`}>
          <span className="kimi-setup__status-icon" aria-hidden="true">
            {view.tone === "ready" ? "✓" : view.tone === "checking" ? "…" : "!"}
          </span>
          <span className="kimi-setup__status-copy">
            <strong>{view.title}</strong>
            <span>{view.detail}</span>
          </span>
        </div>
        {view.action && view.actionLabel && (
          <div className="kimi-setup__actions">
            <button
              type="button"
              className={`kimi-setup__button${view.action === "remove" ? " kimi-setup__button--remove" : ""}`}
              disabled={view.busy}
              onClick={invoke}
            >
              {view.actionLabel}
            </button>
          </div>
        )}
      </div>
    );
  }

  KimiSetupSection.displayName = "KimiSetupSection";
  return KimiSetupSection;
}
