/**
 * The page's connection to the lifecycle machine: the subscription first,
 * then — once the deck has loaded — the boot handshake with the deck as it
 * loaded, and the same again when the machine starts over. The barrier
 * comes down on the handshake; until then the snapshot says it is up, and
 * whatever waits on it waits silently.
 *
 * The order is the rule this owner exists for: a snapshot the machine
 * sends in answer to the handshake must find the subscription already
 * registered, or the commands it carries reach nobody until the next one.
 */
import { deckFactsOf, type DeckFacts, type DeckLoad } from "../../domain/lifecycle";
import type { Workspace } from "../../domain/deck";
import type { Heard } from "../../ipc/generated/lifecycle/Heard";
import type { Reply } from "../../ipc/generated/lifecycle/Reply";
import type { LifecycleSnapshot } from "../lifecycleSnapshot";

export interface LifecycleConnectionPorts {
  subscribe(onHeard: (heard: Heard) => void): Promise<void>;
  onRestarted(handler: () => void): Promise<() => void>;
  handshake(deck: DeckFacts, load: DeckLoad): Promise<Reply>;
}

export interface LifecycleConnectionDeps {
  ports: LifecycleConnectionPorts;
  snapshot: Pick<LifecycleSnapshot, "receive" | "restarted">;
  /** The deck as it loaded, and how — null while it is still loading. */
  loaded(): { workspaces: readonly Workspace[]; load: DeckLoad } | null;
  /** Be told when the load settles. */
  subscribeLoaded(listener: () => void): () => void;
  /** The machine took the handshake: it is up, and has heard the deck. */
  booted(): void;
  /** The machine the page listens to stopped: nothing starts or closes
   * until KeepDeck restarts. */
  stopped(): void;
  warn(message: string): void;
}

export interface LifecycleConnection {
  dispose(): void;
}

export function connectLifecycle(deps: LifecycleConnectionDeps): LifecycleConnection {
  let disposed = false;
  /** Bumped by every connect: a handshake a later connect overtook says
   * nothing about the machine that is there now. */
  let attempt = 0;
  const stops: (() => void)[] = [];

  /** The deck as it loaded, once it has. */
  function whenLoaded(): Promise<{ workspaces: readonly Workspace[]; load: DeckLoad }> {
    const now = deps.loaded();
    if (now) return Promise.resolve(now);
    return new Promise((resolve) => {
      const stop = deps.subscribeLoaded(() => {
        const settled = deps.loaded();
        if (!settled) return;
        stop();
        resolve(settled);
      });
      stops.push(stop);
    });
  }

  async function connect(): Promise<void> {
    const mine = ++attempt;
    await deps.ports.subscribe((heard) => {
      // A machine that started over took the page with it: the old
      // subscription's last words are about a machine that is gone.
      if (disposed || mine !== attempt) return;
      if (heard.kind === "snapshot") deps.snapshot.receive(heard.versioned);
      else deps.stopped();
    });
    const { workspaces, load } = await whenLoaded();
    if (disposed || mine !== attempt) return;
    const reply = await deps.ports.handshake(deckFactsOf(workspaces), load);
    if (reply.kind !== "answered") {
      deps.warn(`lifecycle: the boot handshake got no answer (${reply.kind})`);
    } else if (reply.answer.kind === "refused") {
      deps.warn(`lifecycle: the boot handshake was refused (${reply.answer.refusal.kind})`);
    } else if (!disposed && mine === attempt) {
      deps.booted();
    }
  }

  const failed = (error: unknown) => deps.warn(`lifecycle: connecting failed — ${String(error)}`);
  void connect().catch(failed);
  void deps.ports
    .onRestarted(() => {
      if (disposed) return;
      // A new machine counts its versions from the start again, and has
      // heard no handshake yet.
      deps.snapshot.restarted();
      void connect().catch(failed);
    })
    .then((unlisten) => {
      if (disposed) unlisten();
      else stops.push(unlisten);
    }, failed);

  return {
    dispose() {
      disposed = true;
      for (const stop of stops.splice(0)) stop();
    },
  };
}
