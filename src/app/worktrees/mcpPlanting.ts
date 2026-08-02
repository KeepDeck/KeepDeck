/**
 * The MCP client config a file-fed CLI reads out of its working directory.
 *
 * WHAT is written — the directory, the file name, the body — is the agent
 * plugin's dialect and travels in the entry. This owns only WHEN: both calls
 * take the manager's queue slot, so neither can land inside a
 * `git worktree remove`.
 */
import { mcpArm, mcpDisarm } from "../../ipc/mcpArming";
import type { McpPlanting } from "./index";
import type { InOrder } from "./queue";

export function createMcpPlanting(inOrder: InOrder): McpPlanting {
  return {
    plantMcp(entry) {
      // Queued, and that is the WHOLE guard: a write that started while a
      // teardown is in flight would land inside git's recursive delete.
      //
      // Deliberately NOT re-checked against the live deck, unlike the skills
      // staging. That check exists there because staging arms a SET of roots
      // snapshotted at call time, so by execution time some may have left and
      // the set has to be narrowed. Here there is one root and it is the
      // asking pane's own cwd — nothing to narrow. Re-checking it instead
      // refused every pane the deck cannot see YET: a manual resume, a fork
      // into a directory, a fork into a fresh worktree all plant before the
      // pane lands, and each silently got no servers. The case the check was
      // meant to catch — the directory went away while we queued — is refused
      // by the backend, which reports a cwd that is no longer a directory.
      return inOrder(() => mcpArm([entry]));
    },

    retractMcp(roots) {
      // NOT filtered against the live deck, unlike a teardown's disarm: this is
      // the transport going down, and the configs to take back are exactly the
      // LIVE ones — they name a socket that no longer exists.
      return inOrder(() => mcpDisarm(roots));
    },
  };
}
