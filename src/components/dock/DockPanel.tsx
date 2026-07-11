import { type ReactNode } from "react";

/** One dock tab as the panel renders it: identity, the strip label, and the
 * already-wired panel content (the composition root decides what props each
 * source of tabs gets — legacy tabs take the deck surface, plugin tabs take
 * snapshots inside an error boundary). */
export interface DockTabItem {
  id: string;
  label: string;
  element: ReactNode;
  /** The tab's plugin has a problem (a crashed surface) — the strip shows a
   * red alert badge so the failure is visible before the tab is opened. */
  alert?: boolean;
}

/**
 * The dock: a collapsible tool panel on the right, mirroring the workspaces
 * rail on the left — tabs across the top, one tool per tab. The tab list is
 * OWNED by the caller (legacy built-ins + the plugin registry merged in the
 * composition root); the dock itself only switches. The picked tab is
 * CONTROLLED by the caller — it's remembered per workspace in the deck, so
 * switching workspaces and back returns to the tab that workspace last looked
 * at. Hidden tabs stay MOUNTED, like the settings dialog's sections: the run
 * log's terminal must not re-mount (and replay) on every tab switch.
 */
export function DockPanel({
  tabs,
  activeTab,
  onSelectTab,
}: {
  tabs: DockTabItem[];
  /** The caller's picked tab id. `null` (never chosen) or an id no longer in
   * `tabs` (its plugin was disabled) falls back to the first tab. */
  activeTab: string | null;
  onSelectTab: (id: string) => void;
}) {
  // The picked tab can be absent or disappear — fall back to the first tab
  // instead of rendering an empty dock.
  const activeId = tabs.some((t) => t.id === activeTab) ? activeTab : tabs[0]?.id;

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
            onClick={() => onSelectTab(tab.id)}
          >
            {tab.label}
            {tab.alert && (
              <span
                className="dock__tab-alert"
                role="img"
                aria-label={`${tab.label} has a problem`}
              >
                !
              </span>
            )}
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
