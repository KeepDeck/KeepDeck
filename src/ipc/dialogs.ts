import { open } from "@tauri-apps/plugin-dialog";

/** Native folder picker; resolves to the chosen path, or null when cancelled.
 * Components take this as a prop (they stay free of Tauri imports) — the
 * composition root wires it in. */
export async function pickFolder(title: string): Promise<string | null> {
  const dir = await open({ directory: true, multiple: false, title });
  return typeof dir === "string" ? dir : null;
}

/** Native application picker (macOS: an `.app` bundle, starting in
 * /Applications); resolves to the chosen bundle's path, or null when
 * cancelled. Callers derive the display name from the path. */
export async function pickApplication(): Promise<string | null> {
  const picked = await open({
    multiple: false,
    title: "Choose an application",
    defaultPath: "/Applications",
    filters: [{ name: "Applications", extensions: ["app"] }],
  });
  return typeof picked === "string" ? picked : null;
}
