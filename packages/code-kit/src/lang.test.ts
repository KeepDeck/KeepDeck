import { describe, expect, it } from "vitest";
import { GRAMMARS } from "./grammars";
import { langFor } from "./lang";

describe("the ids langFor can produce", () => {
  it("each names a grammar the kit loads, by its name or an alias", () => {
    // langFor's ids form a closed set; one the grammars do not name would
    // silently cost a file type its color one day. Whether a named grammar
    // then compiles is Shiki's to answer, not the kit's.
    const named = new Set(GRAMMARS.flat().flatMap((grammar) => [grammar.name, ...(grammar.aliases ?? [])]));
    const samples = [
      "a.ts", "a.tsx", "a.js", "a.jsx", "a.json", "a.jsonc", "a.rs", "a.toml",
      "a.yaml", "a.md", "a.html", "a.css", "a.scss", "a.less", "a.sh", "a.py",
      "a.go", "a.java", "a.kt", "a.swift", "a.c", "a.cpp", "a.cs", "a.rb",
      "a.php", "a.sql", "a.xml", "a.diff", "a.ini", "a.graphql", "a.lua",
      "a.vue", "a.svelte", "a.m", "a.pl", "Dockerfile", "Makefile",
    ];
    for (const sample of samples) {
      const lang = langFor(sample);
      expect(lang, sample).not.toBeNull();
      expect(named.has(lang ?? ""), `${sample} -> ${lang}`).toBe(true);
    }
  });
});

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
