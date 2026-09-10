import type { AgentStatusEvent, StatusNormalizer } from "@keepdeck/plugin-api";

/** Decode in file order, without committing either plugin state or activity.
 * Preview and delivery settlement use this same pure operation. */
export function normalizeStatusBatch(
  normalize: StatusNormalizer,
  payloads: readonly unknown[],
  at: number,
  initial: unknown,
  reply?: string,
  contextOnly = false,
): { events: AgentStatusEvent[]; state: unknown } {
  let state = initial;
  const events: AgentStatusEvent[] = [];
  for (const payload of payloads) {
    const result = normalize(payload, at, { reply, state });
    if (!result) continue;
    if (result.kind === "status-reduction") {
      state = result.state;
      if (!contextOnly) events.push(...result.events);
    } else if (!contextOnly) events.push(result);
  }
  return { events, state };
}
