/**
 * The task feature's lifecycle, as ONE owner: the enable policy that tells
 * the store to open and close, the board owner that exists while the store
 * is open, the task_* commands that exist while the owner does AND the MCP
 * socket is up, the human's notifications riding the owner's events, and
 * what a closing workspace forgets. The composition root hands in ports
 * and gets back a handle; nothing about how the pieces fit lives there.
 *
 * The one rule this owner exists to keep: the board owner is created only
 * for an enable that answered THIS generation of the setting. A fast
 * Off→On used to trust the previous On's answer, create the owner while
 * the store was still closing, and let its first read cache "board is off"
 * as an unreadable board forever. Every settings change now forgets the
 * last answer until the policy reports again for the value that stands.
 */
import type { CommandRegistry } from "../../domain/commands";
import type { Workspace } from "../../domain/deck";
import { createEnablePolicy } from "../enablePolicy";
import type { EnableStatus } from "../enableStatus";
import { registerTaskCommands } from "./taskCommands";
import { createTasksService, type TaskEvent, type TasksService, type TasksStorePort } from "./tasksService";

export interface TasksFeatureDeps {
  registry: CommandRegistry;
  workspaces(): readonly Workspace[];
  /** The toggle: null until the settings load settles. */
  settings: { tasks(): boolean | null; subscribe(listener: () => void): () => void };
  /** The deck's MCP socket — the agents' door to the commands. */
  socket: { up(): boolean; subscribe(listener: () => void): () => void };
  store: TasksStorePort & {
    enable(): Promise<unknown>;
    disable(): Promise<unknown>;
    dropWorkspace(workspaceId: string): Promise<void>;
  };
  /** Where the three human notifications go. */
  announce(event: TaskEvent): void;
  /** The last enable transition, kept for the surfaces that say WHY. */
  status: EnableStatus;
}

/** The owner as surfaces read it: present while the feature is up. */
export interface TasksAccess {
  current(): TasksService | null;
  subscribe(listener: () => void): () => void;
}

export interface TasksFeature {
  access: TasksAccess;
  /** A closing workspace's board: forgotten here, dropped on disk. */
  forgetWorkspace(workspaceId: string): Promise<void>;
  /** Stops reconciling and takes the owner and the commands down. Does
   * NOT close the store: its life follows the setting and the process,
   * never the page (`beforeunload` fires on every dev reload). */
  dispose(): void;
}

export function createTasksFeature(deps: TasksFeatureDeps): TasksFeature {
  /** Whether the store is open for the setting that stands NOW — null
   * while no answer for the current value has arrived. */
  let storeOpen: boolean | null = null;
  /** The setting's generation: bumped only when its VALUE changes. The
   * settings feed fires for every setting, and forgetting the store's
   * answer on an unrelated change tore the owner down for good — the
   * policy saw nothing to do and never reported again. */
  let generation = 0;
  let lastValue: boolean | null = deps.settings.tasks();
  /** The generation the backend call now in flight was made for; a
   * report is believed only when it is still the one that stands — the
   * same boolean twice (On, Off, On) is two generations, and the first
   * enable's answer says nothing about the third. */
  let calledFor = generation;
  let service: TasksService | null = null;
  /** The owner taken down on Off, held until the store's disable has
   * flushed its writes — the reconcile that retired it runs before the
   * transport's disable ever does, so `service` is null by then. */
  let retiring: TasksService | null = null;
  let unregister: (() => void) | null = null;
  let disposed = false;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };

  const reconcile = () => {
    if (disposed) return;
    const wanted = (deps.settings.tasks() ?? false) && storeOpen === true;
    if (wanted && service === null) {
      service = createTasksService({ workspaces: deps.workspaces, store: deps.store });
      service.onEvent(deps.announce);
      changed();
    } else if (!wanted && service !== null) {
      unregister?.();
      unregister = null;
      service.dispose();
      retiring = service;
      service = null;
      changed();
    }
    const commandsWanted = service !== null && deps.socket.up();
    if (commandsWanted && unregister === null && service !== null) {
      unregister = registerTaskCommands(deps.registry, { tasks: service, workspaces: deps.workspaces });
    } else if (!commandsWanted && unregister !== null) {
      unregister();
      unregister = null;
    }
  };

  const policy = createEnablePolicy(
    { desired: deps.settings.tasks, subscribe: deps.settings.subscribe },
    {
      enable: () => {
        calledFor = generation;
        return deps.store.enable();
      },
      // Queued writes land before the store closes under them — the
      // RETIRING owner's, which reconcile has already let go of.
      disable: async () => {
        calledFor = generation;
        const gone = retiring ?? service;
        retiring = null;
        await gone?.flush();
        await deps.store.disable();
      },
    },
    (transition) => {
      // An answer counts only for the generation that stands now.
      deps.status.record(transition);
      if (calledFor !== generation) return;
      storeOpen = transition.ok && transition.desired;
      reconcile();
    },
    { target: "web:tasks", feature: "tasks" },
  );

  const stop = [
    deps.settings.subscribe(() => {
      // Only a change of THIS setting is a new generation: whatever the
      // store answered, it answered for the old value, and nothing is
      // known until the policy reports again. Any other setting moving is
      // nothing to us.
      const value = deps.settings.tasks();
      if (value === lastValue) return;
      lastValue = value;
      generation += 1;
      storeOpen = null;
      reconcile();
    }),
    deps.socket.subscribe(reconcile),
  ];
  reconcile();

  return {
    access: {
      current: () => service,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    async forgetWorkspace(workspaceId) {
      service?.forget(workspaceId);
      await deps.store.dropWorkspace(workspaceId);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const s of stop) s();
      unregister?.();
      unregister = null;
      service?.dispose();
      service = null;
      listeners.clear();
      policy.dispose();
    },
  };
}
