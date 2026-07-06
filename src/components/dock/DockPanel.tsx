import { useState, type ReactNode } from "react";

/** One dock tab as the panel renders it: identity, the strip label, and the
 * already-wired panel content (the composition root decides what props each
 * source of tabs gets — legacy tabs take the deck surface, plugin tabs take
 * snapshots inside an error boundary). */
export interface DockTabItem {
  id: string;
  label: string;
  element: ReactNode;
}

/**
 * The dock: a collapsible tool panel on the right, mirroring the workspaces
 * rail on the left — tabs across the top, one tool per tab. The tab list is
 * OWNED by the caller (legacy built-ins + the plugin registry merged in the
 * composition root); the dock itself only switches. Hidden tabs stay
 * MOUNTED, like the settings dialog's sections: the run log's terminal must
 * not re-mount (and replay) on every tab switch.
 */
export function DockPanel({ tabs }: { tabs: DockTabItem[] }) {
  const [tabId, setTabId] = useState<string | null>(null);
  // The picked tab can disappear (its plugin was disabled) — fall back to
  // the first tab instead of rendering an empty dock.
  const activeId = tabs.some((t) => t.id === tabId) ? tabId : tabs[0]?.id;

  return (
    <aside className="dock">
      <div className="dock__tabs" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === activeId}
            className={`dock__tab${tab.id === activeId ? " dock__tab--active" : ""}`}
            onClick={() => setTabId(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className="dock__body"
          hidden={tab.id !== activeId}
          role="tabpanel"
        >
          {tab.element}
        </div>
      ))}
    </aside>
  );
}
