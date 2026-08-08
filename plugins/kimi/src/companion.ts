import reporterManifest from "../resources/keepdeck-session-reporter/kimi.plugin.json";
import teamsManifest from "../resources/keepdeck-teams/kimi.plugin.json";
import type { KimiCompanionDescriptor } from "./manager";

/**
 * The two plugins KeepDeck ships into Kimi Code, and why they are two.
 *
 * The REPORTER says who a session is and how its turns go. The TEAMS plugin
 * tells a starting session that KeepDeck may have put it on a team — Kimi
 * discards whatever a SessionStart hook prints, so a plugin session-start
 * skill is the only door there is, and a hook reporter has no business
 * owning one. Separate zones, separate manifests, separate versions: a
 * change to either must not be able to break the other.
 *
 * To the person configuring Kimi they are still one decision — see
 * `createKimiCompanionFleet`.
 */
const REPORTER_DIRECTORY = "keepdeck-session-reporter";
const TEAMS_DIRECTORY = "keepdeck-teams";

export const COMPANION_ID = reporterManifest.name;
export const COMPANION_VERSION = reporterManifest.version;
export const COMPANION_RESOURCE_DIRECTORY = REPORTER_DIRECTORY;
export const COMPANION_MANIFEST_RESOURCE =
  `${REPORTER_DIRECTORY}/kimi.plugin.json` as const;

/**
 * What "the setup is current" is reported as, once every companion sits at
 * its own expected version.
 *
 * The companions version independently, so no single manifest version can
 * stand for the setup. This marker does, and the controller only ever
 * compares against it — it is a sentinel, never something to show a person.
 */
export const SETUP_VERSION = COMPANION_VERSION;

export const COMPANION_DESCRIPTOR = {
  id: COMPANION_ID,
  version: COMPANION_VERSION,
  displayName: reporterManifest.interface.displayName,
  resourceDirectoryName: REPORTER_DIRECTORY,
} satisfies KimiCompanionDescriptor;

export const TEAMS_DESCRIPTOR = {
  id: teamsManifest.name,
  version: teamsManifest.version,
  displayName: teamsManifest.interface.displayName,
  resourceDirectoryName: TEAMS_DIRECTORY,
} satisfies KimiCompanionDescriptor;

/** Every companion, in install order. The reporter first: it is the one that
 * makes a pane resumable at all, so a setup interrupted halfway leaves the
 * more valuable half in place. */
export const COMPANION_DESCRIPTORS: readonly KimiCompanionDescriptor[] = [
  COMPANION_DESCRIPTOR,
  TEAMS_DESCRIPTOR,
];

/** PluginResources resolves files, while Kimi installs a directory. Derive
 * the containing folder without importing Node path utilities into the web
 * plugin bundle; both native separators are accepted. */
export function parentDirectory(path: string): string | null {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator > 0 ? path.slice(0, separator) : null;
}
