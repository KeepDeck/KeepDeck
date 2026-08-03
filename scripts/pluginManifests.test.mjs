import { readdirSync, readFileSync } from "node:fs";
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
const MANIFESTS = readdirSync("plugins", { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `plugins/${entry.name}/manifest.json`);

describe("built-in plugin manifests", () => {
  it("finds every built-in", () => {
    // A guard on the guard: a glob that silently matched nothing would make
    // every assertion below vacuous.
    expect(MANIFESTS.length).toBeGreaterThan(5);
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

  it("carries a parseable own version", () => {
    // The plugin's DISPLAY version, which stays semver — distinct from the
    // integer API floor above, and bumped whenever the plugin's src or
    // resources change.
    for (const path of MANIFESTS) {
      const { id, version } = JSON.parse(readFileSync(path, "utf8"));
      expect(parseVersion(version), `${path} (${id}) version "${version}"`).not.toBeNull();
    }
  });
});
