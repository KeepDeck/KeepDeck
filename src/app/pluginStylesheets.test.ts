// @vitest-environment happy-dom
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
    const done = ensurePluginStylesheet(
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

    link.dispatchEvent(new Event("load"));
    await done;
    expect(warn).not.toHaveBeenCalled();
  });

  it("is idempotent per plugin id — a restart resolves at once, without a second link", async () => {
    const first = ensurePluginStylesheet("keepdeck.git", "/a.css", () => {});
    links()[0].dispatchEvent(new Event("load"));
    await first;

    await ensurePluginStylesheet("keepdeck.git", "/a.css", () => {});
    expect(links()).toHaveLength(1);
  });

  it("keeps distinct plugins' links apart", () => {
    void ensurePluginStylesheet("keepdeck.git", "/a.css", () => {});
    void ensurePluginStylesheet("keepdeck.files", "/b.css", () => {});
    expect(links()).toHaveLength(2);
  });

  it("warns and still resolves when the stylesheet fails to load", async () => {
    const warn = vi.fn();
    const done = ensurePluginStylesheet("keepdeck.run", "/gone.css", warn);

    links()[0].dispatchEvent(new Event("error"));
    await done;
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("/gone.css failed to load"),
    );
  });
});
