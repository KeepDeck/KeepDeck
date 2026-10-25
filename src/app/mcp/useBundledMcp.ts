import { useRef } from "react";
import type { BundledMcpDescription } from "./bundled";
import { useRuntimePart } from "../runtimeContext";
import { useMcpStatus } from "./useMcpStatus";

/** The bundled tier as a surface lists it, re-read whenever the transport's
 * status moves — what each member shows follows that status (the deck's own
 * server fills in once the socket is confirmed). The set itself is fixed for
 * the service's life. */
export function useBundledMcp(): BundledMcpDescription[] {
  const mcp = useRuntimePart("mcp");
  const status = useMcpStatus();
  // Keyed on the status object: the service publishes a fresh one on every
  // settled transition, and the descriptions follow it. The cache keeps the
  // array's identity for consumers while making the status a real input,
  // rather than a dependency the memo body never reads.
  const cached = useRef<{
    mcp: typeof mcp;
    status: typeof status;
    tier: BundledMcpDescription[];
  } | null>(null);
  if (cached.current === null || cached.current.mcp !== mcp || cached.current.status !== status) {
    cached.current = { mcp, status, tier: mcp.bundled() };
  }
  return cached.current.tier;
}
