import { useMemo } from "react";
import type { BundledMcpDescription } from "./bundled";
import { useAppRuntime } from "../runtimeContext";
import { useMcpStatus } from "./useMcpStatus";

/** The bundled tier as a surface lists it, re-read whenever the transport's
 * status moves — what each member shows follows that status (the deck's own
 * server fills in once the socket is confirmed). The set itself is fixed for
 * the service's life. */
export function useBundledMcp(): BundledMcpDescription[] {
  const { mcp } = useAppRuntime();
  const status = useMcpStatus();
  // Keyed on the status object: the service publishes a fresh one on every
  // settled transition, and the descriptions are a pure function of it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => mcp.bundled(), [mcp, status]);
}
