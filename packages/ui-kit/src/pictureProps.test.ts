import { describe, expect, it } from "vitest";
import { pictureProps } from "./pictureProps";

describe("pictureProps — how a picture is named", () => {
  it("on its own: an image, named for what it says, with the same words on the pointer", () => {
    expect(pictureProps("2 of 5 tasks done")).toEqual({ role: "img", "aria-label": "2 of 5 tasks done", title: "2 of 5 tasks done" });
  });

  it("beside its words: hidden from assistive tech, and carrying no name of its own", () => {
    expect(pictureProps("In progress", true)).toEqual({ "aria-hidden": true });
  });
});
