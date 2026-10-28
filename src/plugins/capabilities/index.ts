export {
  createCapabilityGate,
  type FsBackend,
  type FsScope,
  type GateDiagnostics,
  type ServiceBackends,
} from "./gate";
export { execCovers } from "./execCovers";
export {
  declaresPermissions,
  isResolvedPermissions,
  NO_PERMISSIONS,
  type ResolvedPermissions,
} from "./permissions";
export { createPluginCommandsPort } from "./commandsPort";
