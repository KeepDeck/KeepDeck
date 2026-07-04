import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initSettings } from "./app/settingsManager";
import { initLogging } from "./ipc/log";
import { suppressNativeContextMenu } from "./ui/contextMenu";

initLogging();
suppressNativeContextMenu();
// Kick off the settings load with the other boot IO — the first paint gates
// on it (App renders the bare shell until the store settles).
void initSettings();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Dismiss the pre-React boot screen once the app has actually painted. Boot and
// app share the same dark background, so the hand-off shows no white frame. Two
// rAFs wait for React's initial (synchronous) commit to be painted before the
// fade begins; transitionend removes the node, with a timeout fallback in case
// the transition is skipped (e.g. prefers-reduced-motion).
const boot = document.getElementById("boot");
if (boot) {
  const remove = () => boot.remove();
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      boot.classList.add("boot--hidden");
      boot.addEventListener("transitionend", remove, { once: true });
      setTimeout(remove, 600);
    }),
  );
}
