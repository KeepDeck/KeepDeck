import { describe, expect, it } from "vitest";
import { skillDraftOf } from "./skillFile";

describe("skillDraftOf", () => {
  it("lets the directory name win over the file's", () => {
    // Every CLI keys on the directory, and a hand edit can leave the two apart.
    const draft = skillDraftOf({
      name: "on-disk",
      content: "---\nname: stale-in-file\ndescription: d\n---\nB\n",
    });
    expect(draft).toEqual({
      name: "on-disk",
      description: "d",
      body: "B\n",
      extraFrontmatter: [],
    });
  });

  it("names a file that states no name by its directory", () => {
    expect(skillDraftOf({ name: "bare", content: "Just instructions.\n" }).name).toBe("bare");
  });
});
