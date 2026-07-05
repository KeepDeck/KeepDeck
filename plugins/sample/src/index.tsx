/**
 * The acceptance plugin for the built-in plugin build pipeline
 * (scripts/build-plugins.mjs). It exists to PROVE the pipeline, not to be a
 * real feature — three things about the pipeline only show up if a plugin
 * actually exercises them:
 *
 * 1. A dock tab component that calls `useState`: hooks only work if the
 *    bundle's `react` import was externalized and resolves, at runtime, to
 *    the SAME react instance the host tree renders with (two copies of
 *    react-dom sharing one page corrupts the Fiber tree — see
 *    src/plugins/bridges/react.js).
 * 2. Written as TSX using the automatic JSX runtime (no hand-written
 *    `React.createElement`): only compiles and runs if `react/jsx-runtime`
 *    is externalized and resolves the same way.
 * 3. An event subscription that disposes ITSELF the first time it fires,
 *    ahead of the host's blanket at-deactivation cleanup — proving early
 *    dispose works, not just cleanup-by-construction at teardown.
 */
import { useState } from "react";
import type {
  DockTabProps,
  KeepDeckPlugin,
  PluginContext,
} from "@keepdeck/plugin-api";

// The tab needs the plugin's display name, which lives on `ctx.manifest` —
// not on `DockTabProps` (host-owned snapshot data only) — so `activate`
// closes over it when building the component.
function makeSampleTab(pluginName: string) {
  return function SampleTab(_props: DockTabProps) {
    const [count, setCount] = useState(0);
    return (
      <div style={{ padding: 12 }}>
        <p>{pluginName}</p>
        <button onClick={() => setCount((c) => c + 1)}>
          Clicked {count} {count === 1 ? "time" : "times"}
        </button>
      </div>
    );
  };
}

const activate: KeepDeckPlugin["activate"] = (ctx: PluginContext) => {
  ctx.ui.registerDockTab({
    id: "sample",
    label: "Sample",
    Component: makeSampleTab(ctx.manifest.name),
  });

  ctx.settings.registerSection({
    label: "Sample",
    fields: [
      { kind: "boolean", key: "greet", label: "Show greeting", default: true },
      { kind: "string", key: "note", label: "Note", default: "" },
    ],
  });

  // Fires on the first deck change only — dispose inside the callback, not
  // at deactivation, to prove a plugin can retire a subscription early.
  const deckChanged = ctx.events.onDeckChanged(() => {
    ctx.log.info("sample: deck changed");
    deckChanged.dispose();
  });
};

const plugin: KeepDeckPlugin = { activate };

export default plugin;
