import { useState } from "react";
import { DOCK_TABS, type DockTabProps } from "./tabs";

/**
 * The dock: a collapsible tool panel on the right, mirroring the workspaces
 * rail on the left — tabs across the top, one tool per tab (Run first;
 * future tabs join the `DOCK_TABS` registry). Hidden tabs stay MOUNTED, like
 * the settings dialog's sections: the run log's terminal must not re-mount
 * (and replay) on every tab switch.
 */
export function DockPanel(props: DockTabProps) {
  const [tabId, setTabId] = useState(DOCK_TABS[0].id);

  return (
    <aside className="dock">
      <div className="dock__tabs" role="tablist">
        {DOCK_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === tabId}
            className={`dock__tab${tab.id === tabId ? " dock__tab--active" : ""}`}
            onClick={() => setTabId(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {DOCK_TABS.map((tab) => (
        <div
          key={tab.id}
          className="dock__body"
          hidden={tab.id !== tabId}
          role="tabpanel"
        >
          <tab.Component {...props} />
        </div>
      ))}
    </aside>
  );
}
