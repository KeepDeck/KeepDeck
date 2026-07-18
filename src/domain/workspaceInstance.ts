/**
 * One workspace lifetime inside the running app.
 *
 * Public `ws-N` ids are reusable slots. This token is deliberately
 * non-serializable and never reused, so runtime references can distinguish a
 * deleted workspace from a later workspace occupying the same slot.
 */
export type WorkspaceInstance = symbol;

export function createWorkspaceInstance(): WorkspaceInstance {
  return Symbol("workspace");
}
