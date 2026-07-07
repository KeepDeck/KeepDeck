import { describe, expect, it } from "vitest";
import { gitBadge } from "./gitBadge";

describe("gitBadge", () => {
  it("shows a branch with the full branch as tooltip", () => {
    expect(gitBadge({ branch: "feature/pane-header" })).toEqual({
      label: "feature/pane-header",
      title: "feature/pane-header",
    });
  });

  it("shows a short commit id when detached", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    expect(gitBadge({ head: sha })).toEqual({ label: "0123456", title: sha });
  });

  it("renders no badge when there is no observed git position", () => {
    expect(gitBadge(undefined)).toBeNull();
    expect(gitBadge({})).toBeNull();
  });
});
