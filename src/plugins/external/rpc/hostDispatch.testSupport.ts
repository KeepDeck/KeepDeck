import { vi } from "vitest";
import type { AgentContribution, PluginContext } from "@keepdeck/plugin-api";
import { createHostDispatch } from "./hostDispatch";

/**
 * A dispatch wired to a fake realm, plus the two things a seam test needs to
 * see: what the host PUSHED into the realm, and what contribution the realm's
 * registration produced on this side.
 *
 * `pushes` is the load-bearing half. A proxy's answer can look identical to
 * the answer a fallback would have produced — so a test comparing results
 * cannot tell which path ran. What differs is the call that went out, and
 * that is what this records.
 */
export function dispatchHarness() {
  let registered: AgentContribution | undefined;
  const pushes: { channel: string; payload: unknown }[] = [];
  const ctx = {
    agents: {
      register: vi.fn((agent: AgentContribution) => {
        registered = agent;
        return { dispose() {} };
      }),
    },
  } as unknown as PluginContext;
  const dispatch = createHostDispatch(ctx, (channel, payload) =>
    pushes.push({ channel, payload }),
  );
  return {
    dispatch,
    pushes,
    agent: () => {
      if (!registered) throw new Error("nothing registered");
      return registered;
    },
    /** Settle the Nth history call the host pushed, by its channel id. */
    settleHistory: (index: number, value: unknown) =>
      dispatch.call("agents.historyResult", [
        Number(pushes[index].channel.slice("history:".length)),
        { ok: true, value },
      ]),
  };
}

/** A minimal external agent registration — no capabilities declared. */
export const agentEntry = {
  id: "gemini",
  label: "Gemini",
  detect: { bin: "gemini" },
  hookNames: ["spawn.plan", "definitely.not.a.hook"],
};
