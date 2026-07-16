/**
 * The trust-tier vocabulary shared by every host boundary that checks a
 * plugin's declared capabilities — the services gate and the notify port.
 * One `admit` so a violation can never carry two different policies down two
 * paths: `"warn"` (trusted built-ins — a violation is a bug to log, not a
 * reason to take the session down) reports and lets the call proceed;
 * `"enforce"` (untrusted externals) throws before the backend is reached.
 */
export type GateMode = "warn" | "enforce";

/** Build the tier's single branch point. `warn` is pluggable because callers
 * complain differently (the gate logs plainly, the notify port throttles). */
export function makeAdmit(
  mode: GateMode,
  warn: (message: string) => void,
): (ok: boolean, message: string) => void {
  return (ok, message) => {
    if (ok) return;
    if (mode === "enforce") throw new Error(message);
    warn(message);
  };
}
