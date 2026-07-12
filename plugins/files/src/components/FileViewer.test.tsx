// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FsFile, PluginContext } from "@keepdeck/plugin-api";
import { setRuntime } from "../runtime";
import { FileViewer } from "./FileViewer";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TS_TEXT = 'const s = "hi" // note\n\nexport default s\n';

const fsFile = (path: string, text: string): FsFile => ({
  path,
  text,
  isBinary: false,
  size: text.length,
  truncated: false,
});

function makeCtx(files: Record<string, FsFile>): PluginContext {
  return {
    services: {
      fs: {
        readDir: vi.fn(async () => []),
        readFile: vi.fn(async (path: string) => files[path]),
        watch: vi.fn(() => ({ dispose: () => {} })),
      },
      opener: { openUrl: vi.fn(async () => {}), openPath: vi.fn(async () => {}) },
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext;
}

const rowTexts = () =>
  [...document.querySelectorAll(".files__linetext")].map((n) => n.textContent);

const styledSpans = () =>
  document.querySelectorAll(".files__linetext span[style]");

/** Poll inside act until `ready` — tokenization compiles real grammars, so its
 * latency is genuine work, not a missing flush. */
async function settle(ready: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("settle: condition never held");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
}

describe("FileViewer", () => {
  let host: HTMLElement;
  let root: Root;

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

    // Coloring must not change a single visible character: each row reads
    // exactly as the plain path would render it (empty line = one space).
    expect(rowTexts()).toEqual(
      TS_TEXT.split("\n").map((line) => line || " "),
    );
    // And it IS color: the keyword run differs from the string/comment runs.
    const firstRow = document.querySelector(".files__coderow")!;
    const colors = new Set(
      [...firstRow.querySelectorAll<HTMLElement>("span[style]")].map(
        (span) => span.style.color,
      ),
    );
    expect(colors.size).toBeGreaterThan(1);
  });

  it("keeps an unknown language plain — no spans ever arrive", async () => {
    const path = "/repo/NOTES";
    await mount(path, { [path]: fsFile(path, "just words\nno grammar\n") });

    // Give any (wrong) tokenization ample time to land.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

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

    await act(async () => toggleButton()!.click());

    // Raw: the exact line view every other text file gets.
    expect(document.querySelector(".files__md")).toBeNull();
    expect(rowTexts()[0]).toBe("# Title");
    expect(
      document.querySelector('button[aria-label="Toggle line wrapping"]'),
    ).not.toBeNull();

    await act(async () => toggleButton()!.click());
    expect(document.querySelector(".files__md h1")?.textContent).toBe("Title");
  });

  it("colors fenced code inside the rendered document", async () => {
    const path = "/repo/README.md";
    await mount(path, { [path]: fsFile(path, MD_TEXT) });

    await settle(
      () => document.querySelectorAll(".files__md pre span[style]").length > 0,
    );
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
    expect((window as { pwned?: boolean }).pwned).toBeUndefined();
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
    const external = links.find((a) => a.textContent === "docs")!;
    const relative = links.find((a) => a.textContent === "local")!;
    const openUrl = ctx.services.opener.openUrl as ReturnType<typeof vi.fn>;

    await act(async () => external.click());
    expect(openUrl).toHaveBeenCalledWith("https://example.com/docs");

    await act(async () => relative.click());
    expect(openUrl).toHaveBeenCalledTimes(1); // still only the external one
  });
});
