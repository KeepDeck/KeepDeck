import { open } from "@tauri-apps/plugin-dialog";

/** Native folder picker; resolves to the chosen path, or null when cancelled.
 * Components take this as a prop (they stay free of Tauri imports) — the
 * composition root wires it in. */
export async function pickFolder(title: string): Promise<string | null> {
  const dir = await open({ directory: true, multiple: false, title });
  return typeof dir === "string" ? dir : null;
}
