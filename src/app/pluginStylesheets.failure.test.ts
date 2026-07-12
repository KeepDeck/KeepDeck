// @vitest-environment happy-dom
// Stylesheet loading disabled and reported as FAILURE: happy-dom fires the
// link's `error` synchronously on append, driving the helper's degraded path
// through the environment's own events — no real fetch, no manual dispatch.
// The happy path needs the opposite setting and lives in
// pluginStylesheets.test.ts; environment options are per-file.
// @vitest-environment-options {"settings": {"disableCSSFileLoading": true}}
import { expect, it, vi } from "vitest";
import { ensurePluginStylesheet } from "./pluginStylesheets";

it("warns and still resolves when the stylesheet fails to load", async () => {
  const warn = vi.fn();
  // Resolving (not rejecting) is the contract under test: missing styles must
  // degrade the tab's looks, never fail the plugin's activation.
  await ensurePluginStylesheet("keepdeck.run", "/gone.css", warn);
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining("/gone.css failed to load"),
  );
});
