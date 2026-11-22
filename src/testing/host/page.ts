// The page's own pieces mounted in the deck's page: inside its runtime's
// provider, their modules the deck's — loaded after the deck started, so
// they share its fresh graph (a module imported at a test file's top is
// another instance of the app's stateful modules).
import { act, createElement, type FunctionComponent } from "react";
import { createRoot } from "react-dom/client";
import type { Deck } from "./deck";

/** Render `View` in the deck's page, inside its runtime's provider, as the
 * app's root does; how to take it down. */
export async function renderInPage(d: Deck, View: FunctionComponent): Promise<() => void> {
  const { AppRuntimeProvider } = await import("../../app/runtimeContext");
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(createElement(AppRuntimeProvider, { runtime: d.runtime }, createElement(View))));
  return () => act(() => root.unmount());
}

/** What a mounted hook returned at its last render, and how to let it go. */
export interface Mounted<T> {
  current(): T;
  unmount(): void;
}

/** Mount `use` in the deck's page. `use` calls the hooks the test imported
 * after the deck started. */
export async function mountInPage<T>(d: Deck, use: () => T): Promise<Mounted<T>> {
  let last: { value: T } | null = null;
  const unmount = await renderInPage(d, function Host() {
    last = { value: use() };
    return null;
  });
  return {
    current() {
      if (!last) throw new Error("the hook did not mount");
      return last.value;
    },
    unmount,
  };
}
