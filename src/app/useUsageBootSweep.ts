import { useEffect, useRef } from "react";
import type { AgentUsage } from "@keepdeck/plugin-api";
import { log } from "../ipc/log";
import { latestCodexRollout } from "../ipc/usage";
import { setAccountUsage } from "./usageManager";
import { usageSourceTimestamp } from "./usageProvenance";

/**
 * The boot catch-up lane for codex: rollouts live on disk whether or not
 * KeepDeck was running, so the newest one knows fresher limits than our
 * persisted snapshot whenever codex ran outside the app. One sweep per app
 * run, normalized by the declaring plugin and stamped with the EVENT's
 * source time (file mtime fallback) — never receipt time — so freshest-wins
 * ranks it honestly against the hydrated cache and any live report. Account
 * state only: without a pane there is nothing to attribute.
 *
 * Codex-specific like the TUI-resume fallback (the native command knows
 * the `~/.codex/sessions` layout). The other providers' boot freshness is
 * settled elsewhere: kimi by its polled endpoint (`useLimitsPolling`),
 * claude by nothing — its rate limits never touch disk (verified: no
 * `rate_limits` field in any transcript or cache under `~/.claude`), so
 * its chip honestly ages until the first live statusLine report.
 */
export function useUsageBootSweep(
  usageByAgent: ReadonlyMap<string, AgentUsage>,
): void {
  const usageByAgentRef = useRef(usageByAgent);
  usageByAgentRef.current = usageByAgent;
  const sweptRef = useRef(false);

  // The rollout dialect names the agent whose sessions dir the native
  // command understands.
  const codexAgent =
    [...usageByAgent].find(([, usage]) => usage.tail === "codex")?.[0] ?? "";
  useEffect(() => {
    if (!codexAgent || sweptRef.current) return;
    sweptRef.current = true;
    const normalize = usageByAgentRef.current.get(codexAgent)?.normalize;
    if (!normalize) return;
    void latestCodexRollout()
      .then((found) => {
        if (!found) {
          log.debug("web:usage", "boot sweep: no codex rollout carries usage");
          return;
        }
        const receivedAt = Date.now();
        const sourceAt =
          usageSourceTimestamp(found.sourceAt, receivedAt) ??
          usageSourceTimestamp(found.mtimeMs, receivedAt) ??
          0;
        const result = normalize(
          { agent: codexAgent, event: found.event, catchUp: true },
          sourceAt,
        );
        if (result?.account) setAccountUsage(codexAgent, result.account);
      })
      .catch((e) => log.debug("web:usage", `codex boot sweep failed: ${e}`));
  }, [codexAgent]);
}
