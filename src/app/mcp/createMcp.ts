/**
 * The MCP feature as the composition root holds it: the transport service
 * and the user's library, wired to each other ONCE, behind one door.
 *
 * The two need each other. The service's injection reads the library at
 * every plan; the library refuses to author a name the service's bundled
 * tier holds. Wiring them at the root meant the root naming the bundled
 * server itself — a second home for a fact the tier owns — and composing the
 * per-workspace teardown by hand. Both live here now.
 */
import { createMcpLibrary, type McpLibrary, type McpStorage } from "../mcpLibrary";
import { createMcpService, type McpService, type McpServiceDeps } from "./service";

export interface McpDeps extends Omit<McpServiceDeps, "library"> {
  /** Where the library's files are. */
  storage: McpStorage;
}

export interface Mcp {
  service: McpService;
  library: McpLibrary;
  /** Forget a closing workspace's library scope — the feature's share of the
   * deck's per-workspace teardown; see [`McpLibrary.forgetWorkspace`]. */
  forgetWorkspace(wsId: string): Promise<void>;
  dispose(): void;
}

export function createMcp({ storage, ...serviceDeps }: McpDeps): Mcp {
  // The service goes first and reads the library through a thunk: nothing
  // asks for a workspace's servers before a spawn, long after both exist.
  let library: McpLibrary | null = null;
  const service = createMcpService({
    ...serviceDeps,
    library: {
      serversFor(workspaceId) {
        if (!library) throw new Error("the MCP library is not wired yet");
        return library.serversFor(workspaceId);
      },
    },
  });
  // The tier is fixed for the service's life, so its names are read once.
  library = createMcpLibrary({
    storage,
    reserved: service.bundled().map((server) => server.name),
  });
  const wired = library;
  return {
    service,
    library: wired,
    forgetWorkspace: (wsId) => wired.forgetWorkspace(wsId),
    dispose: () => service.dispose(),
  };
}
