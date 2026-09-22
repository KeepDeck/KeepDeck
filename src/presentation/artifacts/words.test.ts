import { describe, expect, it } from "vitest";
import { deleteQuestion } from "./words";

describe("deleteQuestion", () => {
  it("names the artifact and everything that goes with it", () => {
    expect(deleteQuestion("The auth flow")).toBe(
      'Delete "The auth flow"? Every version goes, its open pages say goodbye, and the id stops resolving',
    );
  });
});
