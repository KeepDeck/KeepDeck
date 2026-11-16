// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AllArchivedStage } from "./AllArchivedStage";
import { present } from "@keepdeck/plugin-api/testing";

describe("AllArchivedStage", () => {
  let root: Root;
  beforeEach(() => {
    document.body.innerHTML = "";
    root = createRoot(document.body.appendChild(document.createElement("div")));
  });
  afterEach(() => act(() => root.unmount()));

  it("says where the workspaces went, and leads back to them or to a new one", () => {
    const onOpenArchived = vi.fn();
    const onCreate = vi.fn();
    act(() => root.render(createElement(AllArchivedStage, { onOpenArchived, onCreate })));
    expect(document.body.textContent).toContain("Every workspace is archived");
    const button = (text: string) =>
      present(Array.from(document.querySelectorAll("button")).find((b) => b.textContent === text), text);
    act(() => button("Show archived workspaces").click());
    act(() => button("New workspace").click());
    expect(onOpenArchived).toHaveBeenCalledOnce();
    expect(onCreate).toHaveBeenCalledOnce();
  });
});
