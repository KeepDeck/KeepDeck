import { invoke } from "@tauri-apps/api/core";
import {
  FALLBACK_AGENTS,
  normalizeAgents,
  type AgentInfo,
} from "../domain/agents";

/** Fetch the agent catalog with install status. Falls back to the static list
 *  (all treated installed) if the backend command errors. */
export async function listAgents(): Promise<AgentInfo[]> {
  try {
    return normalizeAgents(await invoke<AgentInfo[]>("agents_list"));
  } catch (e) {
    console.error("agents_list failed; using fallback catalog", e);
    return FALLBACK_AGENTS;
  }
}
