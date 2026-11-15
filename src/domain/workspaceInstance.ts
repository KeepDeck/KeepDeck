/**
 * One workspace lifetime inside the running app.
 *
 * A workspace's public id names it for its whole life and is never handed to
 * another (older decks' `ws-N` included). This token names ONE run's hold on
 * it: deliberately omitted from persistence and minted again at every
 * hydrate, so a runtime reference resolves only within the run, and a
 * reference that outlived a close resolves to nothing. It is a
 * string (rather than a Symbol) because the same lifetime must cross the
 * plugin RPC boundary and serve as a React key.
 */
declare const workspaceInstanceBrand: unique symbol;
export type WorkspaceInstance = string & {
  readonly [workspaceInstanceBrand]: "WorkspaceInstance";
};

export interface WorkspaceRef {
  id: string;
  instance: WorkspaceInstance;
}

// The salt protects live state across a dev HMR reload that resets the module
// counter. This is identity, not a secret; Math.random is sufficient here.
const runtimeSalt = `${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2)}`;
let nextInstance = 0;

export function createWorkspaceInstance(): WorkspaceInstance {
  nextInstance += 1;
  const instance = `workspace-${runtimeSalt}-${nextInstance}`;
  if (!isWorkspaceInstance(instance)) throw new Error(`${instance} is not a workspace instance`);
  return instance;
}

/** Whether `value` reads as a workspace instance this module minted —
 * `workspace-<salt>-<n>`: what a ref carried across a boundary (a plugin's
 * key, a notification) is checked against before it is trusted as one. */
export function isWorkspaceInstance(value: unknown): value is WorkspaceInstance {
  return typeof value === "string" && /^workspace-[0-9a-z]+-[0-9a-z]*-\d+$/.test(value);
}

/** A lifetime minted here and given to no workspace: what a ref whose
 * instance this app never minted is carried as. It names nothing, so it
 * resolves the way a stale lifetime does — never to a workspace that
 * happens to hold the same public id. */
export const UNMINTED_INSTANCE: WorkspaceInstance = createWorkspaceInstance();

/** `value` as a lifetime: itself when this app minted it, else
 * [`UNMINTED_INSTANCE`]. */
export function workspaceInstanceOf(value: string): WorkspaceInstance {
  return isWorkspaceInstance(value) ? value : UNMINTED_INSTANCE;
}
