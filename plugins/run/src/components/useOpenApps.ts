import { useEffect, useState } from "react";
import { openAppsFrom } from "../domain";
import { getRuntime } from "../runtime";

/**
 * The user-managed "Open in" application list, live out of the plugin's
 * settings (Settings → Run) — read once on mount, re-derived on every
 * values change so an edit in the settings dialog lands in the open tab
 * immediately.
 */
export function useOpenApps(): string[] {
  const { ctx } = getRuntime();
  const [apps, setApps] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    void ctx.settings.read().then((values) => {
      if (alive) setApps(openAppsFrom(values));
    });
    const sub = ctx.settings.onChange((values) => setApps(openAppsFrom(values)));
    return () => {
      alive = false;
      sub.dispose();
    };
  }, [ctx]);

  return apps;
}
