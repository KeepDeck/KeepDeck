import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  API_VERSION,
  MIN_COMPATIBLE_API_VERSION,
  parseVersion,
  satisfiesApiFloor,
} from "../packages/plugin-api/src/manifest/version.ts";

/**
 * The API floor of every BUILT-IN plugin, checked against the host that
 * ships with it. `satisfiesApiFloor` is unit-tested against synthetic
 * numbers; nothing was reading the real manifests, so a floor raised past
 * the host's own revision — or an `API_VERSION` bumped while a manifest
 * already sat above it — would pass CI and only surface at runtime, where
 * the plugin is dropped with a host-log warning and the pane silently
 * loses whatever it contributed.
 */
/** Anchored to the repo, not to the process — a CWD-relative read would
 * quietly find nothing from anywhere but the root and pass every assertion
 * below on an empty list. */
const PLUGINS = join(dirname(fileURLToPath(import.meta.url)), "..", "plugins");

const MANIFESTS = readdirSync(PLUGINS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(PLUGINS, entry.name, "manifest.json"));

/** The built-ins that ship today. A ROSTER, not a smoke test: an empty read
 * would make every assertion below vacuous, and a plugin quietly dropped
 * from the bundle is worth failing over. Adding one keeps this passing;
 * removing one should be a deliberate edit here too. */
const BUILT_INS = 8;

describe("built-in plugin manifests", () => {
  it("finds every built-in", () => {
    expect(MANIFESTS.length).toBeGreaterThanOrEqual(BUILT_INS);
  });

  it("declares a floor the shipped host can actually execute", () => {
    for (const path of MANIFESTS) {
      const { id, minApiVersion } = JSON.parse(readFileSync(path, "utf8"));
      expect(
        satisfiesApiFloor(minApiVersion),
        `${path} (${id}) declares minApiVersion ${minApiVersion}, outside the host's [${MIN_COMPATIBLE_API_VERSION}, ${API_VERSION}]`,
      ).toBe(true);
    }
  });

  it("declares a floor high enough for the contract it actually uses", () => {
    // The floor is a DECLARATION, and `satisfiesApiFloor` checks only that —
    // never what the code reaches for. Three plugins consumed the API-37 mail
    // surface while declaring 31, 32 and 36; on a host at those revisions
    // they would have loaded and silently lost the labelled channel, which is
    // the exact class of quiet degradation the mail work exists to remove.
    //
    // Checked by SYMBOL rather than by a hand-kept list: a plugin that starts
    // using one of these fails here until its floor moves.
    const MAIL_SURFACE = /\b(renderMail|frameTeammateMail|cliVersion|\.standing\b|wake:)/;
    const MAIL_API = 37;
    for (const path of MANIFESTS) {
      const { id, minApiVersion } = JSON.parse(readFileSync(path, "utf8"));
      const src = join(dirname(path), "src");
      const uses = readdirSync(src, { withFileTypes: true, recursive: true })
        .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
        .filter((entry) => !entry.name.includes(".test."))
        .some((entry) =>
          MAIL_SURFACE.test(readFileSync(join(entry.parentPath, entry.name), "utf8")),
        );
      if (!uses) continue;
      expect(
        minApiVersion,
        `${path} (${id}) uses the mail contract but declares minApiVersion ${minApiVersion}`,
      ).toBeGreaterThanOrEqual(MAIL_API);
    }
  });

  it("carries a parseable own version", () => {
    // The plugin's DISPLAY version, which stays semver — distinct from the
    // integer API floor above.
    //
    // Parseability is ALL this checks. Whether the version was bumped for a
    // change is a question about two commits, which a unit test cannot see;
    // saying otherwise here would be worse than saying nothing, because a
    // reader would stop looking for the check that does not exist. Review is
    // what catches an unbumped plugin.
    for (const path of MANIFESTS) {
      const { id, version } = JSON.parse(readFileSync(path, "utf8"));
      expect(parseVersion(version), `${path} (${id}) version "${version}"`).not.toBeNull();
    }
  });
});
