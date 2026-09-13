import { describe, expect, it } from "vitest";
import { repoTrouble } from "./repoState";

describe("repoTrouble", () => {
  it("reads the state out of the host's exact wording", () => {
    // The crate's Display of a failed command, as the host relays it.
    expect(
      repoTrouble(
        "`git status --porcelain=v2 --branch -z --untracked-files=all` failed (exit 128): fatal: not a git repository (or any of the parent directories): .git",
      ),
    ).toEqual({ kind: "not-repo" });
    expect(repoTrouble("failed to run git: No such file or directory (os error 2)")).toEqual({
      kind: "no-git",
    });
    expect(
      repoTrouble(
        "`git log --format=… -n50 HEAD --` failed (exit 128): fatal: your current branch 'main' does not have any commits yet",
      ),
    ).toEqual({ kind: "no-commits" });
    expect(repoTrouble("path is outside the allowed workspace roots: /elsewhere")).toEqual({
      kind: "out-of-scope",
    });
  });

  it("anything else keeps git's own first line, without the command frame and tag", () => {
    expect(
      repoTrouble(
        "`git diff --no-color -- x.ts` failed (exit 128): fatal: bad object deadbeef\nhint: something more",
      ),
    ).toEqual({ kind: "failed", detail: "bad object deadbeef" });
    expect(repoTrouble("`git rev-parse HEAD` failed (signal): error: killed")).toEqual({
      kind: "failed",
      detail: "killed",
    });
  });

  it("a message with no command frame is taken as it is", () => {
    expect(repoTrouble("no such path: /repo")).toEqual({
      kind: "failed",
      detail: "no such path: /repo",
    });
  });
});
