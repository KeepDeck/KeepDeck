/**
 * The MCP feature's front door. A consumer depends on the FEATURE, not on
 * the module inside it: the composition root holds [`createMcp`], the spawn
 * path and the surfaces take what they need from here.
 */
export * from "./service";
export { createMcp, type Mcp, type McpDeps } from "./createMcp";
export type {
  McpAccess,
  McpAccessAsk,
  McpInjectable,
  McpInjectionTarget,
  McpServerSource,
} from "./injection";
export { KEEPDECK_MCP_SERVER, type BundledMcpDescription } from "./bundled";
export type { McpPaneIdentity } from "./paneIdentity";
