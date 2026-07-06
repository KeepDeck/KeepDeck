/**
 * The wire vocabulary, re-exported from its single source of truth in the host
 * app (`src/plugins/external/rpc/protocol.ts`). The two ends MUST agree byte for
 * byte, so there is exactly one definition and this is a view onto it — the
 * cross-package relative import is deliberate: the protocol is dependency-free
 * (types plus a few pure channel builders), so pulling it into a plugin bundle
 * drags nothing else from the host along.
 */
export * from "../../../src/plugins/external/rpc/protocol";
