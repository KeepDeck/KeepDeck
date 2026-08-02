export {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  errorReply,
  requestIdOf,
  resultReply,
  type JsonRpcId,
} from "./jsonrpc";
export {
  MCP_PROTOCOL_VERSION,
  handleMcpLine,
  toolNameOf,
  type McpCommandPort,
  type McpServerIdentity,
} from "./protocol";
// `isValidMcpServerName` stays unexported on purpose: reaching for it alone
// skips the duplicate-name half of the policy, which is what keeps the
// built-in server unshadowable.
export { acceptMcpServers, type McpServerDef } from "./servers";
export { shellLine } from "./shellLine";
