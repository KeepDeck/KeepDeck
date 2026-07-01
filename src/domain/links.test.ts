import { describe, expect, it } from "vitest";
import { detectLinks, resolvePathTarget } from "./links";

const kinds = (line: string) =>
  detectLinks(line).map((l) => `${l.kind}:${l.text}`);

describe("detectLinks — URLs", () => {
  it("detects an http(s) URL", () => {
    expect(kinds("see https://github.com/o/r/issues/1")).toEqual([
      "url:https://github.com/o/r/issues/1",
    ]);
  });

  it("trims trailing sentence punctuation from a URL", () => {
    const links = detectLinks("open https://example.com.");
    expect(links[0].text).toBe("https://example.com");
    expect(links[0].kind).toBe("url");
  });

  it("does not also match the URL's path as a file path", () => {
    expect(kinds("https://github.com/a/b.ts")).toEqual([
      "url:https://github.com/a/b.ts",
    ]);
  });
});

describe("detectLinks — paths", () => {
  it("detects an absolute path", () => {
    expect(kinds("at /Users/me/proj/main.rs done")).toEqual([
      "path:/Users/me/proj/main.rs",
    ]);
  });

  it("detects an absolute path without an extension", () => {
    expect(kinds("cd /usr/local/bin")).toEqual(["path:/usr/local/bin"]);
  });

  it("detects ./ ../ ~/ prefixed paths", () => {
    expect(kinds("./src/a.ts")).toEqual(["path:./src/a.ts"]);
    expect(kinds("../pkg/b.rs")).toEqual(["path:../pkg/b.rs"]);
    expect(kinds("~/notes/todo.md")).toEqual(["path:~/notes/todo.md"]);
  });

  it("detects a relative path with an extension", () => {
    expect(kinds("edit src/app/main.tsx now")).toEqual([
      "path:src/app/main.tsx",
    ]);
  });

  it("keeps a trailing :line:col in the match", () => {
    expect(kinds("error in src/foo.ts:42:7")).toEqual(["path:src/foo.ts:42:7"]);
    expect(kinds("/a/b/x.go:10")).toEqual(["path:/a/b/x.go:10"]);
  });

  it("ignores extension-less relative tokens like and/or, n/a", () => {
    expect(detectLinks("either and/or, n/a here")).toEqual([]);
  });

  it("finds several links on one line", () => {
    expect(kinds("see https://x.com and /tmp/log.txt")).toEqual([
      "url:https://x.com",
      "path:/tmp/log.txt",
    ]);
  });
});

describe("resolvePathTarget", () => {
  const cwd = "/Users/me/proj";

  it("returns an absolute path unchanged (minus :line:col)", () => {
    expect(resolvePathTarget("/a/b/x.ts:9:2", cwd)).toBe("/a/b/x.ts");
  });

  it("resolves a relative path against the pane cwd", () => {
    expect(resolvePathTarget("src/foo.ts:42", cwd)).toBe(
      "/Users/me/proj/src/foo.ts",
    );
  });

  it("leaves a ~ path for the backend to expand", () => {
    expect(resolvePathTarget("~/notes.md", cwd)).toBe("~/notes.md");
  });

  it("tolerates a trailing slash on cwd", () => {
    expect(resolvePathTarget("a/b.ts", "/c/")).toBe("/c/a/b.ts");
  });
});
