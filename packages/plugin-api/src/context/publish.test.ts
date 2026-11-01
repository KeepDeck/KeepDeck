import { describe, expect, it } from "vitest";
import { publishingTree } from "../testing.ts";
import { oneAtATime, publishCopy, publishFiles, VIEW_FINGERPRINT_FILE } from "./publish.ts";

function recording() {
  const calls: string[] = [];
  return {
    calls,
    fsWrite: {
      writeFile: async (path: string, text: string) => void calls.push(`write ${path} ${text}`),
      copyDir: async (src: string, dst: string) => void calls.push(`copy ${src} -> ${dst}`),
      remove: async (path: string) => void calls.push(`remove ${path}`),
      move: async (src: string, dst: string) => void calls.push(`move ${src} -> ${dst}`),
    },
  };
}

describe("publishFiles", () => {
  it("clears a stale build, writes every entry aside, then replaces the directory whole", async () => {
    const r = recording();
    await publishFiles(r.fsWrite, "/d/plugin", [
      { path: ".claude-plugin/plugin.json", text: "{}" },
      { path: "skills", copyOf: "/staging/ws-1/skills" },
    ]);
    expect(r.calls).toEqual([
      "remove /d/plugin.tmp",
      "write /d/plugin.tmp/.claude-plugin/plugin.json {}",
      "copy /staging/ws-1/skills -> /d/plugin.tmp/skills",
      "move /d/plugin.tmp -> /d/plugin",
    ]);
  });

  it("refuses a path that would leave the directory, before anything is published", async () => {
    for (const path of ["../escape", "a/../../b", "/abs", "a//b", ""]) {
      for (const entry of [{ path, text: "" }, { path, copyOf: "/staging/ws-1/skills" }]) {
        const r = recording();
        await expect(publishFiles(r.fsWrite, "/d/x", [entry])).rejects.toThrow("not a path inside");
        expect(r.calls).toEqual(["remove /d/x.tmp"]);
      }
    }
  });
});

describe("publishCopy", () => {
  it("publishes a directory that is one copy, built aside and moved over the old one", async () => {
    const r = recording();
    await publishCopy(r.fsWrite, "/d/config/skills", "/staging/ws-1/skills");
    expect(r.calls).toEqual([
      "remove /d/config/skills.tmp",
      "copy /staging/ws-1/skills -> /d/config/skills.tmp",
      "move /d/config/skills.tmp -> /d/config/skills",
    ]);
  });
});

describe("publishing with read: a directory already as asked is left as it is", () => {
  const VIEW = "/staging/ws-1/skills";
  /** A staged view saying `said` of itself, as the host stages one. */
  const viewSaying = (said: string | null, skill = "A") => ({
    [`${VIEW}/a/SKILL.md`]: skill,
    ...(said === null ? {} : { [`${VIEW}/${VIEW_FINGERPRINT_FILE}`]: said }),
  });
  const entries = (manifest = "{}") => [
    { path: ".claude-plugin/plugin.json", text: manifest },
    { path: "skills", copyOf: VIEW },
  ];
  /** Something no publish writes: still there afterwards only if nothing
   * was published over it. */
  const mark = (tree: ReturnType<typeof publishingTree>, dir: string) => tree.fsWrite.writeFile(`${dir}/mark`, "");
  const marked = (tree: ReturnType<typeof publishingTree>, dir: string) => tree.files(dir).includes("mark");

  it("publishes once, and again only when what it would hold moved", async () => {
    const tree = publishingTree(viewSaying("sha256:1"));
    await publishFiles(tree.fsWrite, "/d/plugin", entries(), tree.fs);
    expect(tree.files("/d/plugin")).toEqual([
      ".claude-plugin/plugin.json",
      ".keepdeck-published",
      `skills/${VIEW_FINGERPRINT_FILE}`,
      "skills/a/SKILL.md",
    ]);

    await mark(tree, "/d/plugin");
    await publishFiles(tree.fsWrite, "/d/plugin", entries(), tree.fs);
    expect(marked(tree, "/d/plugin"), "the same entries, the same view: left as it is").toBe(true);

    await publishFiles(tree.fsWrite, "/d/plugin", entries('{"v":2}'), tree.fs);
    expect(marked(tree, "/d/plugin"), "a text entry changed").toBe(false);
    expect(tree.read("/d/plugin/.claude-plugin/plugin.json")).toBe('{"v":2}');
  });

  it("publishes again once the view it copied says something else of itself", async () => {
    const tree = publishingTree(viewSaying("sha256:1"));
    await publishFiles(tree.fsWrite, "/d/plugin", entries(), tree.fs);
    await mark(tree, "/d/plugin");
    // Restaged: other content, and other words for it.
    await tree.fsWrite.remove(VIEW);
    for (const [path, text] of Object.entries(viewSaying("sha256:2", "A2"))) await tree.fsWrite.writeFile(path, text);

    await publishFiles(tree.fsWrite, "/d/plugin", entries(), tree.fs);

    expect(marked(tree, "/d/plugin")).toBe(false);
    expect(tree.read("/d/plugin/skills/a/SKILL.md")).toBe("A2");
    expect(tree.read(`/d/plugin/skills/${VIEW_FINGERPRINT_FILE}`)).toBe("sha256:2");
  });

  it("never takes a copy for current on its stamp alone: the copy must say what its source says", async () => {
    // Published while the view said 1; the copy since holds what a later
    // stage made — as a copy made under a newer stage than its plan would.
    const tree = publishingTree(viewSaying("sha256:1"));
    await publishFiles(tree.fsWrite, "/d/plugin", entries(), tree.fs);
    await tree.fsWrite.writeFile(`/d/plugin/skills/${VIEW_FINGERPRINT_FILE}`, "sha256:2");
    await mark(tree, "/d/plugin");

    await publishFiles(tree.fsWrite, "/d/plugin", entries(), tree.fs);

    expect(marked(tree, "/d/plugin")).toBe(false);
    expect(tree.read(`/d/plugin/skills/${VIEW_FINGERPRINT_FILE}`)).toBe("sha256:1");
  });

  it("publishes every time from a view that says nothing of itself — a host older than the fingerprint", async () => {
    const tree = publishingTree(viewSaying(null));
    await publishFiles(tree.fsWrite, "/d/plugin", entries(), tree.fs);
    await mark(tree, "/d/plugin");
    await publishFiles(tree.fsWrite, "/d/plugin", entries(), tree.fs);
    expect(marked(tree, "/d/plugin")).toBe(false);
  });

  it("publishes again when the stamp cannot be read", async () => {
    const tree = publishingTree(viewSaying("sha256:1"));
    await publishFiles(tree.fsWrite, "/d/plugin", entries(), tree.fs);
    await mark(tree, "/d/plugin");
    const unreadable = { readFile: async () => Promise.reject(new Error("refused")) };
    await publishFiles(tree.fsWrite, "/d/plugin", entries(), unreadable);
    expect(marked(tree, "/d/plugin")).toBe(false);
  });

  it("without read, publishes every time and keeps no stamp — as before", async () => {
    const tree = publishingTree(viewSaying("sha256:1"));
    await publishFiles(tree.fsWrite, "/d/plugin", entries());
    expect(tree.files("/d/plugin")).not.toContain(".keepdeck-published");
    await mark(tree, "/d/plugin");
    await publishFiles(tree.fsWrite, "/d/plugin", entries());
    expect(marked(tree, "/d/plugin")).toBe(false);
  });

  it("leaves a published copy as it is the same way", async () => {
    const tree = publishingTree(viewSaying("sha256:1"));
    await publishCopy(tree.fsWrite, "/d/config/skills", VIEW, tree.fs);
    expect(tree.files("/d/config/skills")).toEqual([VIEW_FINGERPRINT_FILE, ".keepdeck-published", "a/SKILL.md"]);
    await mark(tree, "/d/config/skills");

    await publishCopy(tree.fsWrite, "/d/config/skills", VIEW, tree.fs);
    expect(marked(tree, "/d/config/skills")).toBe(true);

    await tree.fsWrite.writeFile(`${VIEW}/${VIEW_FINGERPRINT_FILE}`, "sha256:2");
    await publishCopy(tree.fsWrite, "/d/config/skills", VIEW, tree.fs);
    expect(marked(tree, "/d/config/skills")).toBe(false);
  });
});

describe("oneAtATime", () => {
  it("runs work for one key in order, and other keys alongside", async () => {
    const serial = oneAtATime();
    const log: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const a1 = serial("a", async () => {
      await held;
      log.push("a1");
    });
    const a2 = serial("a", async () => void log.push("a2"));
    const b1 = serial("b", async () => void log.push("b1"));
    await b1;
    expect(log).toEqual(["b1"]);
    release();
    await Promise.all([a1, a2]);
    expect(log).toEqual(["b1", "a1", "a2"]);
  });

  it("lets a failure answer its caller without stalling the next", async () => {
    const serial = oneAtATime();
    const failed = serial("k", async () => Promise.reject(new Error("no")));
    await expect(failed).rejects.toThrow("no");
    await expect(serial("k", async () => 1)).resolves.toBe(1);
  });
});
