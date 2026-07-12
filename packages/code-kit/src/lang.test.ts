import { describe, expect, it } from "vitest";
import { langFor } from "./lang";

describe("langFor", () => {
  it("maps common extensions to their language ids", () => {
    expect(langFor("/repo/src/main.ts")).toBe("typescript");
    expect(langFor("/repo/src/App.tsx")).toBe("tsx");
    expect(langFor("/repo/lib.rs")).toBe("rust");
    expect(langFor("/repo/pyproject.toml")).toBe("toml");
    expect(langFor("/repo/ci.yml")).toBe("yaml");
    expect(langFor("/repo/README.md")).toBe("markdown");
    expect(langFor("/repo/query.sql")).toBe("sql");
    expect(langFor("/repo/scripts/build.sh")).toBe("shellscript");
  });

  it("is case-insensitive on the basename", () => {
    expect(langFor("/repo/README.MD")).toBe("markdown");
    expect(langFor("/repo/Main.TS")).toBe("typescript");
  });

  it("resolves ambiguous extensions by the documented opinion", () => {
    expect(langFor("/repo/vec.h")).toBe("c");
    expect(langFor("/repo/vec.hpp")).toBe("cpp");
    expect(langFor("/repo/AppDelegate.m")).toBe("objective-c");
  });

  it("recognizes languages carried by a whole basename", () => {
    expect(langFor("/repo/Dockerfile")).toBe("docker");
    expect(langFor("/repo/Dockerfile.dev")).toBe("docker");
    expect(langFor("/repo/Makefile")).toBe("make");
    expect(langFor("/home/user/.zshrc")).toBe("shellscript");
  });

  it("returns null for unknown or absent extensions", () => {
    expect(langFor("/repo/LICENSE")).toBeNull();
    expect(langFor("/repo/data.xyz-unknown")).toBeNull();
    expect(langFor("/repo/.gitignore")).toBeNull();
  });

  it("reads only the last path segment", () => {
    // The directory carries a known "extension" — it must not leak into the
    // basename-less file inside it.
    expect(langFor("/repo/bundle.js/LICENSE")).toBeNull();
    expect(langFor("C:\\repo\\src\\main.rs")).toBe("rust");
  });
});
