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

/** One file whose bytes the pane wire depends on, pinned by digest.
 *
 * The version in kimi.plugin.json is the version KIMI sees; these digests
 * are the version the WIRE sees. History proved the difference real: on
 * 2026-08-26 the reporter scripts switched from dropping envelope files to
 * posting them, kimi.plugin.json kept its 1.6.0, and every installed copy
 * kept speaking the dead protocol while the version check read "current".
 * The listed files are exactly the three whose silent drift breaks the
 * wire — the two hooks that speak it, and the manifest that wires events
 * to them. Nothing else in the directory runs at a pane's runtime. */
export interface CompanionScript {
  file: string;
  sha256: string;
}

const REPORTER_SCRIPTS: readonly CompanionScript[] = [
  { file: "kd-session-hook.sh", sha256: "f4393bea5b2fcac84fb34a98c4605c4546b131c95077f8ce9e5de14f78f331b0" },
  { file: "kd-status-hook.sh", sha256: "7acf2681a1d563112f3ea46721767b8d4f8d0fd19305fb541ae381146714d017" },
  { file: "kimi.plugin.json", sha256: "4fb1950023aedcaaf709af91f6439a8d42076f59b127724be66f9ad8194f7c14" },
];

/** SHA-256 of a file's text, hex-lowercase. The same helper digests what
 * this build ships and what the managed copy installed, so the two sides
 * of the comparison can never disagree about the hashing itself. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

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
  scripts: REPORTER_SCRIPTS,
} satisfies KimiCompanionDescriptor;

export const TEAMS_DESCRIPTOR = {
  id: teamsManifest.name,
  version: teamsManifest.version,
  displayName: teamsManifest.interface.displayName,
  resourceDirectoryName: TEAMS_DIRECTORY,
  // No pane wire: the teams plugin ships a skill, not hooks, and its drift
  // cannot silently break a running pane the way a stale reporter can.
  scripts: [],
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
