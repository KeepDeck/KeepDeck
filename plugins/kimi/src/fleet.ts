/**
 * Several Kimi companions behind one setup story.
 *
 * KeepDeck now ships two plugins into Kimi and they have separate jobs: the
 * session reporter says who a session is and how its turns go, and the teams
 * plugin tells a starting session that it may be on a team. Keeping them
 * apart is deliberate — a change to one must not be able to break the other
 * — but to the person in Settings they are not two decisions. Both are
 * needed, neither is useful alone, and being asked twice would only make
 * "half configured" a state somebody has to understand.
 *
 * So this is a COMPOSITE: it satisfies the same `KimiCompanionManager` the
 * controller already drives, and the controller never learns there is more
 * than one. What it adds is the combining rule — one installation summary
 * out of several — and that rule is deliberately pessimistic: the setup is
 * only as good as its weakest member, because a member that is missing,
 * disabled or broken takes its own capability down with it.
 */
import { SETUP_VERSION } from "./companion";
import type {
  KimiCompanionDescriptor,
  KimiCompanionInstallation,
  KimiCompanionManager,
} from "./manager";

export interface KimiFleetMember {
  descriptor: KimiCompanionDescriptor;
  manager: KimiCompanionManager;
}

/** Join a resources root to a companion's own folder. Both separators are
 * accepted for the same reason `parentDirectory` accepts both: this runs in
 * the web bundle, where Node's path utilities are not available. */
function within(root: string, directory: string): string {
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root.replace(/[/\\]$/, "")}${separator}${directory}`;
}

/** One member's state, beside the version KeepDeck ships for THAT member —
 * the companions version independently, so "current" is a per-member
 * question even though the answer is reported for the setup as a whole. */
export interface KimiFleetReading {
  expected: string;
  installation: KimiCompanionInstallation | null;
}

/**
 * The whole setup as one installation, or null when it is not there.
 *
 * Null when ANY member is missing, because a half-installed setup is not a
 * lesser version of a working one — it is a setup with a capability silently
 * absent, and the honest thing to offer for it is "Configure".
 *
 * The `version` it reports is the SETUP's, not any one plugin's: the shipped
 * marker while every member sits at its own expected version, and null the
 * moment one does not. Null is what the controller reads as out of date,
 * which is exactly right, and naming one member's version there would put a
 * number on screen that answers a question nobody asked.
 */
export function combineInstallations(
  readings: readonly KimiFleetReading[],
): KimiCompanionInstallation | null {
  if (readings.length === 0) return null;
  const present: KimiCompanionInstallation[] = [];
  for (const reading of readings) {
    if (!reading.installation) return null;
    present.push(reading.installation);
  }
  const current = readings.every(
    (reading) => reading.installation?.version === reading.expected,
  );
  return {
    version: current ? SETUP_VERSION : null,
    enabled: present.every((member) => member.enabled),
    healthy: present.every((member) => member.healthy),
    owned: present.every((member) => member.owned),
  };
}

/**
 * Drive several companions as one.
 *
 * `configure` takes the RESOURCES ROOT that holds them all rather than one
 * companion's folder — each member knows its own directory name, and having
 * the caller name a single directory is what would force this to be two
 * buttons.
 */
export function createKimiCompanionFleet(
  members: readonly KimiFleetMember[],
): KimiCompanionManager {
  const each = <T,>(
    run: (member: KimiFleetMember) => Promise<T>,
  ): Promise<T[]> =>
    // SEQUENTIALLY: the members share one Kimi setup server, and it serves
    // one transaction at a time. Running them together would queue anyway,
    // and would report a failure against whichever finished first.
    members.reduce<Promise<T[]>>(
      async (sofar, member) => [...(await sofar), await run(member)],
      Promise.resolve([]),
    );

  const readings = (
    installations: readonly (KimiCompanionInstallation | null)[],
  ): KimiFleetReading[] =>
    members.map((member, index) => ({
      expected: member.descriptor.version,
      installation: installations[index] ?? null,
    }));

  return {
    async inspect() {
      return combineInstallations(
        readings(await each((member) => member.manager.inspect())),
      );
    },

    async configure(resourcesRoot) {
      const installed = combineInstallations(
        readings(
          await each((member) =>
            member.manager.configure(
              within(resourcesRoot, member.descriptor.resourceDirectoryName),
            ),
          ),
        ),
      );
      // Unreachable through `configure`, which answers with an installation
      // per member or throws. Said out loud rather than cast away: a silent
      // null here would surface as "not configured" right after a successful
      // install, which is the most confusing possible report.
      if (!installed) throw new Error("Kimi setup finished with nothing installed.");
      return installed;
    },

    async remove() {
      return combineInstallations(
        readings(await each((member) => member.manager.remove())),
      );
    },

    async dispose() {
      // Every member wraps the SAME setup server, so one dispose is the
      // whole fleet's — disposing per member would tear the server down
      // under the ones still holding it.
      await members[0]?.manager.dispose();
    },
  };
}
