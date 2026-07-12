// @vitest-environment happy-dom
// Stylesheet loading is disabled but reported as SUCCESS: happy-dom fires the
// link's `load` synchronously on append (no real fetch — an in-flight one
// would abort at window teardown as an unhandled rejection), so these tests
// exercise the helper's happy path through the environment's own events. The
// error path needs the opposite setting and lives in its own file
// (pluginStylesheets.failure.test.ts) — environment options are per-file.
// (Vitest wraps this JSON in the happyDOM key itself — passing
// {"happyDOM": ...} here would nest it twice and silently apply nothing.)
// @vitest-environment-options {"settings": {"disableCSSFileLoading": true, "handleDisabledFileLoadingAsSuccess": true}}
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensurePluginStylesheet } from "./pluginStylesheets";

const links = () =>
  [...document.head.querySelectorAll("link[data-kd-plugin-css]")] as HTMLLinkElement[];

describe("ensurePluginStylesheet", () => {
  beforeEach(() => {
    for (const link of links()) link.remove();
  });

  it("appends a stylesheet link marked with the plugin id and resolves on load", async () => {
    const warn = vi.fn();
    await ensurePluginStylesheet(
      "keepdeck.git",
      "/plugins/keepdeck.git/index.css",
      warn,
    );

    const [link] = links();
    expect(link.rel).toBe("stylesheet");
    expect(link.getAttribute("href")).toBe("/plugins/keepdeck.git/index.css");
    expect(link.dataset.kdPluginCss).toBe("keepdeck.git");
    // Appended to the END of head — after the app's own stylesheets, so the
    // plugin's rules keep the "last in the cascade" position index.css gave
    // them before plugins owned their CSS.
    expect(document.head.lastElementChild).toBe(link);
    expect(warn).not.toHaveBeenCalled();
  });

  it("is idempotent per plugin id — a restart resolves at once, without a second link", async () => {
    await ensurePluginStylesheet("keepdeck.git", "/a.css", () => {});
    await ensurePluginStylesheet("keepdeck.git", "/a.css", () => {});
    expect(links()).toHaveLength(1);
  });

  it("keeps distinct plugins' links apart", async () => {
    await ensurePluginStylesheet("keepdeck.git", "/a.css", () => {});
    await ensurePluginStylesheet("keepdeck.files", "/b.css", () => {});
    expect(links()).toHaveLength(2);
  });
});
