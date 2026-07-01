import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Coding-agent kind a pane runs. Mirrors the Rust catalog ids
 *  (`keepdeck-agents::AGENTS`) — the id set is the only thing duplicated in TS;
 *  labels/commands/detection are single-sourced in Rust and fetched. */
export type AgentType = "claude" | "opencode" | "codex";

/** An agent from the backend catalog, annotated with install detection.
 *  Mirrors the Rust `AgentDto` (camelCase). */
export interface AgentInfo {
  id: AgentType;
  label: string;
  /** CLI command to spawn (passed back to `session_spawn`). */
  command: string;
  /** Whether the CLI resolves on the augmented PATH. */
  installed: boolean;
  /** Absolute path of the resolved binary, when installed. */
  path: string | null;
}

/** Static fallback catalog — used only if `agents_list` errors, so the picker is
 *  never empty. Kept minimal and in sync with the Rust `AGENTS` ids; `installed`
 *  is assumed true here since we couldn't detect (better to offer than to hide). */
const FALLBACK_AGENTS: AgentInfo[] = [
  { id: "claude", label: "Claude Code", command: "claude", installed: true, path: null },
  { id: "opencode", label: "OpenCode", command: "opencode", installed: true, path: null },
  { id: "codex", label: "Codex", command: "codex", installed: true, path: null },
];

/** Normalize a catalog response: a non-empty list passes through; anything empty
 *  falls back to the static catalog so the UI always has something to offer. */
export function normalizeAgents(raw: AgentInfo[] | null | undefined): AgentInfo[] {
  return raw && raw.length > 0 ? raw : FALLBACK_AGENTS;
}

/** Agents to offer in the picker: installed only, but the full catalog when none
 *  are detected — never lock the user out of creating an agent ([F1]). */
export function selectableAgents(agents: AgentInfo[]): AgentInfo[] {
  const installed = agents.filter((a) => a.installed);
  return installed.length > 0 ? installed : agents;
}

/** Pick a sensible agent type from the selectable set: keep `preferred` if it's
 *  still selectable, else the first selectable, else `"claude"` (pre-load / empty). */
export function defaultAgentType(
  agents: AgentInfo[],
  preferred?: AgentType,
): AgentType {
  const pool = selectableAgents(agents);
  if (preferred && pool.some((a) => a.id === preferred)) return preferred;
  return pool[0]?.id ?? "claude";
}

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

/** Load the agent catalog into component state. Fetches per mount, so re-opening
 *  a spawn form re-detects (a just-installed agent shows up without a restart). */
export function useAgents(): { agents: AgentInfo[]; loading: boolean } {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    listAgents().then((a) => {
      if (!alive) return;
      setAgents(a);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);
  return { agents, loading };
}
