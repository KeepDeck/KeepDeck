// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FsFile } from "@keepdeck/plugin-api";
import { setRuntime, type FilesPorts } from "../runtime";
import { fsOf, inertPorts } from "../filesPorts.test-support";
import { FileViewer } from "./FileViewer";
import { present } from "@keepdeck/plugin-api/testing";
import { recordOf } from "@keepdeck/plugin-api/testing";
import { installTokenWorker, type TokenWorker } from "@keepdeck/code-kit/testing";

const TS_TEXT = 'const s = "hi" // note\n\nexport default s\n';

const fsFile = (path: string, text: string): FsFile => ({
  path,
  text,
  isBinary: false,
  size: text.length,
  truncated: false,
  readBytes: text.length,
});

function makeCtx(files: Record<string, FsFile>): FilesPorts {
  return inertPorts({
    services: {
      fs: fsOf({
        readDir: vi.fn(async () => []),
        readFile: vi.fn(async (path: string) => files[path]),
        watch: vi.fn(() => ({ ready: Promise.resolve(), dispose: () => {} })),
      }),
      opener: { openUrl: vi.fn(async () => {}), openPath: vi.fn(async () => {}) },
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
}

const rowTexts = () =>
  [...document.querySelectorAll(".files__linetext")].map((n) => n.textContent);

const styledSpans = () =>
  document.querySelectorAll(".files__linetext span[style]");

/** Flush React until `ready`. The token worker answers on a microtask, so
 * colors land within a few flushes; no clock is involved. */
async function settle(ready: () => boolean, flushes = 10) {
  for (let flush = 0; !ready(); flush++) {
    if (flush === flushes) throw new Error(`settle: condition never held in ${flushes} flushes`);
    await act(async () => {});
  }
}

describe("FileViewer", () => {
  let host: HTMLElement;
  let root: Root;
  // Colors are this viewer's input, not its subject: what a real grammar
  // makes of a text is code-kit's own suite.
  let worker: TokenWorker;

  beforeAll(() => {
    worker = installTokenWorker();
  });

  const mount = async (path: string, files: Record<string, FsFile>) => {
    setRuntime(makeCtx(files));
    await act(async () => {
      root.render(
        createElement(FileViewer, { path, root: "/repo", onClose: vi.fn() }),
      );
    });
    // Flush the readFile kicked off on mount.
    await act(async () => {});
  };

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    setRuntime(null);
  });

  it("colors a known language's lines without changing their text", async () => {
    const path = "/repo/src/main.ts";
    await mount(path, { [path]: fsFile(path, TS_TEXT) });
    await settle(() => styledSpans().length > 0);

    expect(worker.asked).toContainEqual({ text: TS_TEXT, lang: "typescript" });
    // Coloring must not change a single visible character: each row reads
    // exactly as the plain path would render it (empty line = one space).
    expect(rowTexts()).toEqual(
      TS_TEXT.split("\n").map((line) => line || " "),
    );
    // The gutter opts OUT of the peek's selection island, or a copied file
    // body arrives with line numbers welded into it.
    for (const cell of document.querySelectorAll(".files__lineno")) {
      expect(cell.classList.contains("kd-inert")).toBe(true);
    }
    // And it IS color: the keyword run differs from the string/comment runs.
    const firstRow = present(document.querySelector(".files__coderow"), "the .files__coderow element");
    const colors = new Set(
      [...firstRow.querySelectorAll<HTMLElement>("span[style]")].map(
        (span) => span.style.color,
      ),
    );
    expect(colors.size).toBeGreaterThan(1);
  });

  it("keeps an unknown language plain — no spans ever arrive", async () => {
    const path = "/repo/NOTES";
    const asked = worker.asked.length;
    await mount(path, { [path]: fsFile(path, "just words\nno grammar\n") });
    await settle(() => rowTexts().length > 0);

    // Not "no colors yet": nothing was asked to color it at all.
    expect(worker.asked.slice(asked)).toEqual([]);
    expect(styledSpans().length).toBe(0);
    expect(rowTexts()[0]).toBe("just words");
  });

  const MD_TEXT = [
    "# Title",
    "",
    "Some [docs](https://example.com/docs) and [local](./other.md).",
    "",
    "```ts",
    "const x = 1",
    "```",
    "",
  ].join("\n");

  const toggleButton = () =>
    document.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle Markdown source view"]',
    );

  it("renders markdown as a document by default and toggles to raw source", async () => {
    const path = "/repo/README.md";
    await mount(path, { [path]: fsFile(path, MD_TEXT) });

    // Rendered: a real heading element, no line-numbered rows, no wrap toggle
    // (nothing to wrap in a document).
    expect(document.querySelector(".files__md h1")?.textContent).toBe("Title");
    expect(document.querySelector(".files__code")).toBeNull();
    expect(
      document.querySelector('button[aria-label="Toggle line wrapping"]'),
    ).toBeNull();

    await act(async () => present(toggleButton(), "the toggleButton").click());

    // Raw: the exact line view every other text file gets.
    expect(document.querySelector(".files__md")).toBeNull();
    expect(rowTexts()[0]).toBe("# Title");
    expect(
      document.querySelector('button[aria-label="Toggle line wrapping"]'),
    ).not.toBeNull();

    await act(async () => present(toggleButton(), "the toggleButton").click());
    expect(document.querySelector(".files__md h1")?.textContent).toBe("Title");
  });

  it("colors fenced code inside the rendered document", async () => {
    const path = "/repo/README.md";
    await mount(path, { [path]: fsFile(path, MD_TEXT) });

    await settle(
      () => document.querySelectorAll(".files__md pre span[style]").length > 0,
    );
    // In the fence's own language, as the fence names it.
    expect(worker.asked).toContainEqual({ text: "const x = 1", lang: "ts" });
    expect(
      document.querySelector(".files__md pre code")?.textContent,
    ).toContain("const x = 1");
  });

  it("never executes or renders raw HTML from the document", async () => {
    const path = "/repo/README.md";
    const hostile =
      '# Hi\n\n<script>window.pwned = true</script>\n<img src="x" onerror="window.pwned = true">\n';
    await mount(path, { [path]: fsFile(path, hostile) });

    expect(document.querySelector(".files__md script")).toBeNull();
    expect(document.querySelector(".files__md img")).toBeNull();
    expect(recordOf(window, "window")).not.toHaveProperty("pwned");
  });

  it("routes external links to the opener and keeps relative ones inert", async () => {
    const path = "/repo/README.md";
    const files = { [path]: fsFile(path, MD_TEXT) };
    setRuntime(null);
    const ctx = makeCtx(files);
    setRuntime(ctx);
    await act(async () => {
      root.render(
        createElement(FileViewer, { path, root: "/repo", onClose: vi.fn() }),
      );
    });
    await act(async () => {});

    const links = [...document.querySelectorAll<HTMLAnchorElement>(".files__md a")];
    const external = present(links.find((a) => a.textContent === "docs"), "the matching item");
    const relative = present(links.find((a) => a.textContent === "local"), "the matching item");
    const openUrl = vi.mocked(ctx.services.opener.openUrl);

    await act(async () => external.click());
    expect(openUrl).toHaveBeenCalledWith("https://example.com/docs");

    await act(async () => relative.click());
    expect(openUrl).toHaveBeenCalledTimes(1); // still only the external one
  });

  it("a second file opened over the first starts at the top", async () => {
    // FilesOverlay keeps ONE viewer across open requests, so a terminal link
    // followed while a preview is open swaps `path` on the mounted component
    // — the previous file's scroll offset is right there to be inherited.
    const files = {
      "/repo/a.ts": fsFile("/repo/a.ts", TS_TEXT),
      "/repo/b.ts": fsFile("/repo/b.ts", TS_TEXT),
    };
    await mount("/repo/a.ts", files);
    const body = present(host.querySelector<HTMLElement>(".peek__body"), "the .peek__body element");
    body.scrollTop = 720;
    body.scrollLeft = 90;

    await mount("/repo/b.ts", files);

    expect(host.querySelector(".peek__body")).toBe(body);
    expect(body.scrollTop).toBe(0);
    expect(body.scrollLeft).toBe(0);
  });

  it("the Markdown source is its own thing to read, from its own top", async () => {
    const path = "/repo/README.md";
    await mount(path, { [path]: fsFile(path, "# Title\n\nsome prose\n") });
    const body = present(host.querySelector<HTMLElement>(".peek__body"), "the .peek__body element");
    body.scrollTop = 500;

    await act(async () =>
      present(host
        .querySelector<HTMLElement>('[aria-label="Toggle Markdown source view"]'), "the [aria-label=\"Toggle Markdown source view\"] element")
        .click(),
    );

    // A document and its source share a path but not a single line, and the
    // rendered view is the shorter of the two — carrying the offset over
    // would have clamped it away and lost the place in both.
    expect(host.querySelector(".files__code")).not.toBeNull();
    expect(host.querySelector(".peek__body")).toBe(body);
    expect(body.scrollTop).toBe(0);
  });

  it("toggling wrap holds the reader's line, not their pixel offset", async () => {
    const path = "/repo/wide.ts";
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    await mount(path, { [path]: fsFile(path, text) });
    const body = present(host.querySelector<HTMLElement>(".peek__body"), "the .peek__body element");
    const code = present(host.querySelector<HTMLElement>(".files__code"), "the .files__code element");

    // happy-dom lays nothing out, so stand in for a layout: the viewport
    // starts at 100 and rows are 20 tall, which puts row 5 as the first one
    // still (partly) on screen.
    vi.spyOn(body, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 100, 0, 0),
    );
    const rows = [...code.children];
    rows.forEach((row, i) =>
      vi.spyOn(row, "getBoundingClientRect").mockReturnValue(
        new DOMRect(0, 0, 0, i * 20 + 20),
      ),
    );
    const held = rows.map((row) =>
      vi.spyOn(row, "scrollIntoView").mockImplementation(() => {}),
    );
    body.scrollTop = 100;

    await act(async () =>
      present(host.querySelector<HTMLElement>('[aria-label="Toggle line wrapping"]'), "the [aria-label=\"Toggle line wrapping\"] element").click(),
    );

    // Exactly the line they were reading is put back at the top. Wrapping
    // re-lays-out the same lines, so it is NOT a different thing to read —
    // the peek must not have reset anything.
    expect(held.filter((row) => row.mock.calls.length)).toHaveLength(1);
    expect(held[5]).toHaveBeenCalledWith({ block: "start" });
    expect(body.scrollTop).toBe(100);
  });
});
