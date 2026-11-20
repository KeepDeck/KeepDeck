/**
 * The lifecycle machine's doors, as the page reaches them — stateless: each
 * call is one Rust command, and nothing here decides anything. Intents are
 * the closed set Rust names (`Intent`); the machine's own events — a
 * session appearing, a timer, a journal write — have no door here, so the
 * page cannot send them.
 *
 * The page hears the machine on ONE channel: the versioned snapshot. Its
 * commands to the data owners ride inside it, so there is no second channel
 * whose order against the first could matter.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Claim } from "./generated/lifecycle/Claim";
import type { CommandId } from "./generated/lifecycle/CommandId";
import type { DeckFacts } from "./generated/lifecycle/DeckFacts";
import type { Dir } from "./generated/lifecycle/Dir";
import type { Heard } from "./generated/lifecycle/Heard";
import type { Intent } from "./generated/lifecycle/Intent";
import type { LeaseAsk } from "./generated/lifecycle/LeaseAsk";
import type { Load } from "./generated/lifecycle/Load";
import type { Location } from "./generated/lifecycle/Location";
import type { OpId } from "./generated/lifecycle/OpId";
import type { Outcome } from "./generated/lifecycle/Outcome";
import type { PermitId } from "./generated/lifecycle/PermitId";
import type { Place } from "./generated/lifecycle/Place";
import type { Preview } from "./generated/lifecycle/Preview";
import type { Reply } from "./generated/lifecycle/Reply";
import type { Revision } from "./generated/lifecycle/Revision";
import type { WorkspaceId } from "./generated/lifecycle/WorkspaceId";

/** What the page hears when the machine started over — a copy that got the
 * journal root late: the page handshakes again. Mirrors `RESTARTED` in
 * src-tauri/src/lifecycle/mod.rs. */
export const LIFECYCLE_RESTARTED = "lifecycle://restarted";

/** The snapshot now, then each change — and that the machine stopped, if it
 * does. */
export async function subscribeLifecycle(onHeard: (heard: Heard) => void): Promise<void> {
  const channel = new Channel<Heard>();
  channel.onmessage = onHeard;
  await invoke("lifecycle_subscribe", { onHeard: channel });
}

export function onLifecycleRestarted(handler: () => void): Promise<UnlistenFn> {
  return listen(LIFECYCLE_RESTARTED, handler);
}

/** The deck as loaded, and how it loaded: the barrier comes down on it. */
export function bootHandshake(deck: DeckFacts, load: Load): Promise<Reply> {
  return invoke<Reply>("lifecycle_boot_handshake", { deck, load });
}

export function sendIntent(intent: Intent): Promise<Reply> {
  return invoke<Reply>("lifecycle_intent", { intent });
}

export function askLease(lease: LeaseAsk): Promise<Reply> {
  return invoke<Reply>("lifecycle_lease", { lease });
}

export function releaseLease(permit: PermitId): Promise<void> {
  return invoke("lifecycle_release", { permit });
}

/** An owner's answer to a command of the snapshot. */
export function reportApplied(id: CommandId, outcome: Outcome): Promise<void> {
  return invoke("lifecycle_applied", { id, outcome });
}

/** The fork step's hook call has ended — its outcome or not. */
export function reportHookEnded(op: OpId): Promise<void> {
  return invoke("lifecycle_hook_ended", { op });
}

/** A deck at this revision is on disk. */
export function reportDeckSaved(revision: Revision): Promise<void> {
  return invoke("lifecycle_deck_saved", { revision });
}

export function previewIntent(intent: Intent): Promise<Preview> {
  return invoke<Preview>("lifecycle_preview", { intent });
}

/** What holds a folder: the operations of the machine that name it. */
export function claimsOn(path: Dir): Promise<Claim[]> {
  return invoke<Claim[]>("lifecycle_claims", { path });
}

/** The place hint for a new team, or the verdict on one typed by hand. */
export function locationFor(workspace: WorkspaceId, candidate: Place | null): Promise<Location> {
  return invoke<Location>("lifecycle_location", { workspace, candidate });
}
