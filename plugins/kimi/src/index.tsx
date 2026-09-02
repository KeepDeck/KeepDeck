import "./styles.css";
import { kimiForkPlan } from "./fork";
import { kimiHistory } from "./history";
import type { KeepDeckPlugin, SpawnSkillsInput } from "@keepdeck/plugin-api";
import {
  COMPANION_DESCRIPTORS,
  sha256Hex,
  COMPANION_MANIFEST_RESOURCE,
  parentDirectory,
} from "./companion";
import { createKimiCompanionFleet } from "./fleet";
import { icon } from "./icon";
import { createKimiCompanionManager } from "./manager";
import { createKimiServerManager } from "./serverManager";
import {
  createKimiSetupController,
  type SetupState,
} from "./setupController";
import { createSetupSection } from "./SetupSection";
import { normalizeKimiStatus, renderKimiMail } from "./status";
import {
  kimiUsageWatches,
  normalizeKimiUsages,
  normalizeKimiWire,
} from "./usage";

let activeController: ReturnType<typeof createKimiSetupController> | null = null;

/** The staged shared skills via `--skills-dir`. CAVEAT (kimi 0.27,
 * `--help`-verified): the flag REPLACES kimi's auto-discovered user and
 * project skill directories rather than adding to them — so it is passed
 * only when the user actually has KeepDeck skills, and such panes see the
 * KeepDeck library instead of `~/.kimi`-style discovery. Revisit if kimi
 * grows an additive flag (its `extra_skill_dirs` is config-file-only). */
const skillsArgs = (skills: SpawnSkillsInput | undefined): string[] =>
  skills ? ["--skills-dir", skills.skillsDir] : [];

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
      // Tokens/context ride the tailed wire.jsonl; rate windows exist only
      // behind the polled usages endpoint (kimi's own /usage queries it too).
      usage: {
        normalize: normalizeKimiWire,
        tail: { format: "kimi-wire", watches: kimiUsageWatches },
        limits: { poll: "kimi-usages", normalize: normalizeKimiUsages },
      },
      // Turn lifecycle from the companion's hooks — the fullest surface of
      // the four agents (native Interrupt, PermissionResult, typed
      // StopFailure), so no out-of-band recovery is needed at all.
      status: { normalize: normalizeKimiStatus, renderMail: renderKimiMail },
      history: kimiHistory(ctx),
      hooks: {
        "spawn.plan": (input, output) => {
          output.args = [
            ...skillsArgs(input.skills),
            ...(input.yolo ? ["--yolo"] : []),
          ];
        },
        "resume.plan": (input, output) => {
          output.args = [
            ...skillsArgs(input.skills),
            ...(input.yolo ? ["--yolo"] : []),
            "--session",
            input.sessionId,
          ];
        },
        "fork.plan": async (input, output) => {
          const newId = await kimiForkPlan(ctx, input);
          output.args = [
            ...skillsArgs(input.skills),
            ...(input.yolo ? ["--yolo"] : []),
            "--session",
            newId,
          ];
        },
      },
    });

    // The RESOURCES ROOT, not one companion's folder: the fleet installs
    // several plugins that live side by side under it, and each knows its
    // own directory name. Resolved through the reporter's manifest because
    // `resources.path` answers about files, and every companion's root is
    // this one's parent.
    const companionManifest = await ctx.resources.path(
      COMPANION_MANIFEST_RESOURCE,
    );
    const companionDirectory = companionManifest
      ? parentDirectory(parentDirectory(companionManifest) ?? "")
      : null;
    const server = createKimiServerManager(ctx.services.sessions);
    // What "current" means for a companion's script files: the bytes this
    // build SHIPS (digested once per activation), against the managed copy
    // on disk. Digested eagerly here — a resource that cannot be read at
    // activation is a packaging bug, and failing now names it instead of
    // failing per inspect, later, with less context.
    // Digested once per activation. A resource this build does not carry
    // (a dev tree without the bundle) leaves that companion's map EMPTY —
    // the manager then has nothing to compare and no claim to make, which
    // is the same state that build's configure() has always been in: it
    // cannot install the file either. No throw: registration must survive
    // a bundle-less build, as it always has.
    const shippedByFile = new Map<string, ReadonlyMap<string, string>>();
    for (const descriptor of COMPANION_DESCRIPTORS) {
      const digests = new Map<string, string>();
      try {
        for (const { file } of descriptor.scripts) {
          const path = await ctx.resources.path(
            `${descriptor.resourceDirectoryName}/${file}`,
          );
          const read = path
            ? await ctx.services.fs.readFile(path)
            : null;
          if (read?.text) digests.set(file, await sha256Hex(read.text));
        }
      } catch {
        // Partial is fine: every file that DID read is still verifiable.
      }
      shippedByFile.set(descriptor.id, digests);
    }
    const fleet = createKimiCompanionFleet(
      COMPANION_DESCRIPTORS.map((descriptor) => ({
        descriptor,
        manager: createKimiCompanionManager(
          server,
          descriptor,
          {
            list: async () => {
              try {
                const entries = await ctx.services.fs.readDir(
                  `~/.kimi-code/plugins/managed/${descriptor.id}`,
                );
                return new Set(entries.map((entry) => entry.name));
              } catch {
                return null;
              }
            },
            read: async (file) => {
              const read = await ctx.services.fs.readFile(
                `~/.kimi-code/plugins/managed/${descriptor.id}/${file}`,
              );
              if (read.text === null) {
                throw new Error(`kimi: installed ${file} is not text`);
              }
              return read.text;
            },
            shipped: async () => shippedByFile.get(descriptor.id)!,
          },
        ),
      })),
    );
    const controller = createKimiSetupController(
      fleet,
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
