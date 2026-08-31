import { describe, expect, it, vi } from "vitest";
import {
  COMPANION_DESCRIPTOR,
  SETUP_VERSION,
  TEAMS_DESCRIPTOR,
} from "./companion";
import { combineInstallations, createKimiCompanionFleet } from "./fleet";
import type {
  KimiCompanionInstallation,
  KimiCompanionManager,
} from "./manager";

const healthy = (version: string): KimiCompanionInstallation => ({
  version,
  enabled: true,
  healthy: true,
  owned: true,
  scriptsCurrent: true,
});

/** A member that answers with whatever it is given, and records what it was
 * asked to install from. */
function member(
  descriptor: typeof COMPANION_DESCRIPTOR,
  installed: KimiCompanionInstallation | null,
) {
  const manager: KimiCompanionManager = {
    inspect: vi.fn(async () => installed),
    configure: vi.fn(async () => installed ?? healthy(descriptor.version)),
    remove: vi.fn(async () => null),
    dispose: vi.fn(async () => {}),
  };
  return { descriptor, manager };
}

describe("combineInstallations", () => {
  it("calls a half-installed setup NOT INSTALLED", () => {
    // Not a lesser version of a working setup — a setup with one capability
    // silently absent. The honest thing to offer for it is "Configure".
    expect(
      combineInstallations([
        { expected: "1.6.0", installation: healthy("1.6.0") },
        { expected: "1.0.0", installation: null },
      ]),
    ).toBeNull();
    expect(combineInstallations([])).toBeNull();
  });

  it("reports the setup as current only when EVERY member is at its own version", () => {
    // The companions version independently, so no single manifest version
    // stands for the setup. Current is the shipped marker; anything else is
    // null, which the controller reads as out of date.
    expect(
      combineInstallations([
        { expected: "1.6.0", installation: healthy("1.6.0") },
        { expected: "1.0.0", installation: healthy("1.0.0") },
      ])?.version,
    ).toBe(SETUP_VERSION);
    expect(
      combineInstallations([
        { expected: "1.6.0", installation: healthy("1.6.0") },
        { expected: "1.0.0", installation: healthy("0.9.0") },
      ])?.version,
    ).toBeNull();
  });

  it("is not current when a member's installed scripts drifted from the shipped bytes", () => {
    // The 1.6.0 lie: Kimi reports the expected version while the installed
    // hooks still speak a protocol the deck no longer reads. Only the
    // scripts verdict tells that setup from a working one, so it alone must
    // be enough to unsettle "current" — and to carry scriptsCurrent=false
    // to the controller's outdated path.
    const drifted: KimiCompanionInstallation = {
      ...healthy("1.6.0"),
      scriptsCurrent: false,
    };
    const combined = combineInstallations([
      { expected: "1.6.0", installation: drifted },
      { expected: "1.0.0", installation: healthy("1.0.0") },
    ]);
    expect(combined?.version).toBeNull();
    expect(combined?.scriptsCurrent).toBe(false);
  });

  it("is only as good as its weakest member", () => {
    // One disabled or broken companion takes its own capability down with
    // it, and a summary that averaged that away would leave the person
    // looking at "configured" while half of it does nothing.
    const combined = combineInstallations([
      { expected: "1.6.0", installation: healthy("1.6.0") },
      { expected: "1.0.0", installation: { ...healthy("1.0.0"), enabled: false } },
    ]);
    expect(combined).toMatchObject({ enabled: false, healthy: true, owned: true });
    const broken = combineInstallations([
      { expected: "1.6.0", installation: { ...healthy("1.6.0"), owned: false } },
      { expected: "1.0.0", installation: healthy("1.0.0") },
    ]);
    expect(broken).toMatchObject({ owned: false });
  });
});

describe("createKimiCompanionFleet", () => {
  it("installs each companion from its own folder under the resources root", () => {
    // The caller names the root that holds them all; having it name one
    // directory is what would force this to be two buttons.
    const reporter = member(COMPANION_DESCRIPTOR, healthy(COMPANION_DESCRIPTOR.version));
    const teams = member(TEAMS_DESCRIPTOR, healthy(TEAMS_DESCRIPTOR.version));
    const fleet = createKimiCompanionFleet([reporter, teams]);

    return fleet.configure("/app/resources").then((installed) => {
      expect(reporter.manager.configure).toHaveBeenCalledWith(
        `/app/resources/${COMPANION_DESCRIPTOR.resourceDirectoryName}`,
      );
      expect(teams.manager.configure).toHaveBeenCalledWith(
        `/app/resources/${TEAMS_DESCRIPTOR.resourceDirectoryName}`,
      );
      expect(installed.version).toBe(SETUP_VERSION);
    });
  });

  it("tolerates a trailing separator on the root rather than doubling it", async () => {
    const teams = member(TEAMS_DESCRIPTOR, healthy(TEAMS_DESCRIPTOR.version));
    await createKimiCompanionFleet([teams]).configure("/app/resources/");
    expect(teams.manager.configure).toHaveBeenCalledWith(
      `/app/resources/${TEAMS_DESCRIPTOR.resourceDirectoryName}`,
    );
  });

  it("disposes ONCE, because every member holds the same setup server", async () => {
    // Disposing per member would tear the server down under the ones still
    // using it.
    const reporter = member(COMPANION_DESCRIPTOR, null);
    const teams = member(TEAMS_DESCRIPTOR, null);
    await createKimiCompanionFleet([reporter, teams]).dispose();
    expect(reporter.manager.dispose).toHaveBeenCalledTimes(1);
    expect(teams.manager.dispose).not.toHaveBeenCalled();
  });
});
