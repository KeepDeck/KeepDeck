import "./styles.css";
import type { KeepDeckPlugin } from "@keepdeck/plugin-api";
import {
  COMPANION_DESCRIPTOR,
  COMPANION_MANIFEST_RESOURCE,
  parentDirectory,
} from "./companion";
import { icon } from "./icon";
import { createKimiCompanionManager } from "./manager";
import { createKimiServerManager } from "./serverManager";
import {
  createKimiSetupController,
  type SetupState,
} from "./setupController";
import { createSetupSection } from "./SetupSection";

let activeController: ReturnType<typeof createKimiSetupController> | null = null;

export function setupNotification(state: SetupState): {
  title: string;
  body: string;
  severity: "warning";
  tag: string;
} | null {
  if (state.kind === "not-configured") {
    return {
      title: "Setup required",
      body: "Configure Kimi Code in Settings to restore sessions after KeepDeck restarts.",
      severity: "warning",
      tag: "setup-required",
    };
  }
  if (state.kind === "needs-attention") {
    return {
      title: "Setup needs attention",
      body: "Open Kimi Code settings and configure the integration to restore sessions reliably.",
      severity: "warning",
      tag: "setup-required",
    };
  }
  return null;
}

const plugin: KeepDeckPlugin = {
  async activate(ctx) {
    ctx.agents.register({
      id: "kimi",
      label: "Kimi Code",
      icon,
      detect: { bin: "kimi" },
      supportsYolo: true,
      hooks: {
        "spawn.plan": (input, output) => {
          output.args = input.yolo ? ["--yolo"] : [];
        },
        "resume.plan": (input, output) => {
          output.args = [
            ...(input.yolo ? ["--yolo"] : []),
            "--session",
            input.sessionId,
          ];
        },
      },
    });

    const companionManifest = await ctx.resources.path(
      COMPANION_MANIFEST_RESOURCE,
    );
    const companionDirectory = companionManifest
      ? parentDirectory(companionManifest)
      : null;
    const server = createKimiServerManager(ctx.services.sessions);
    const manager = createKimiCompanionManager(server, COMPANION_DESCRIPTOR);
    const controller = createKimiSetupController(
      manager,
      companionDirectory,
      ctx.log,
    );
    activeController = controller;
    ctx.settings.registerSection({
      label: "Kimi Code",
      fields: [
        {
          kind: "custom",
          key: "setup",
          Component: createSetupSection(controller),
        },
      ],
    });

    // activate() runs only for enabled plugins. Inspect Kimi's real plugin
    // state on every KeepDeck launch so an external disable/remove is visible
    // immediately rather than trusting stale KeepDeck-owned metadata.
    void controller.check().then((state) => {
      if (activeController !== controller) return;
      const notification = setupNotification(state);
      if (notification) ctx.notify(notification);
    });
  },

  async deactivate() {
    const controller = activeController;
    activeController = null;
    await controller?.dispose();
  },
};

export default plugin;
