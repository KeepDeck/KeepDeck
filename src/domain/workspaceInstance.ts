/**
 * One workspace lifetime inside the running app.
 *
 * Public `ws-N` ids are reusable slots. This token is deliberately omitted
 * from persistence and never reused, so runtime references can distinguish a
 * deleted workspace from a later workspace occupying the same slot. It is a
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
  return `workspace-${runtimeSalt}-${nextInstance}` as WorkspaceInstance;
}
