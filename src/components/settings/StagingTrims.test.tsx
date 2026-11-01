// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stagingTrims } from "../../app/testing";
import { STAGING_TRIMS_TITLE } from "../../presentation/stagingTrimsView";
import { StagingTrims } from "./StagingTrims";
import { present } from "@keepdeck/plugin-api/testing";

describe("StagingTrims", () => {
  let root: Root;
  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(present(document.getElementById("host"), "host"));
  });
  afterEach(() => {
    act(() => root.unmount());
    act(() => stagingTrims.clear());
  });

  it("says nothing while every skill reaches agents whole", () => {
    act(() => root.render(createElement(StagingTrims)));
    expect(document.body.textContent).toBe("");
  });

  it("says what a stage left out, and follows the store as the user fixes it", () => {
    act(() => root.render(createElement(StagingTrims)));
    const web = { id: "ws-1", instance: "life-1", name: "web" };
    act(() =>
      stagingTrims.record(web, [{ scope: "global", skill: "review", kind: "link-out", path: "lib", count: 1 }]),
    );
    expect(document.body.textContent).toContain(STAGING_TRIMS_TITLE);
    expect(document.body.textContent).toContain("review/lib: links outside the skill — left out");
    act(() => stagingTrims.record(web, []));
    expect(document.body.textContent).toBe("");
  });
});
