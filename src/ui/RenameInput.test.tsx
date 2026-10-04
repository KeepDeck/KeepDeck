// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RenameInput } from "./RenameInput";
import { useInlineRename } from "./useInlineRename";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Host({ multiline, commit }: { multiline?: boolean; commit: (key: string, name: string) => void }) {
  const rename = useInlineRename(commit);
  return rename.editing === null
    ? createElement("button", { onClick: () => rename.start("k", "Draft") }, "edit")
    : createElement(RenameInput, { rename, className: "site", label: "Name", multiline });
}

describe("RenameInput", () => {
  let root: Root;
  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.restoreAllMocks();
  });

  it("is one line by default, and wraps as a growing field when the name may — Enter still commits, no line break", () => {
    // As WebKit does: focusing a field puts its caret at the START.
    for (const proto of [HTMLInputElement.prototype, HTMLTextAreaElement.prototype]) {
      const focus = proto.focus;
      vi.spyOn(proto, "focus").mockImplementation(function (this: HTMLInputElement) {
        focus.call(this);
        this.setSelectionRange(0, 0);
      });
    }
    const commit = vi.fn();
    act(() => root.render(createElement(Host, { commit })));
    act(() => document.querySelector("button")!.click());
    const line = document.querySelector<HTMLInputElement>("input.rename-input")!;
    expect(document.activeElement).toBe(line);
    expect([line.selectionStart, line.selectionEnd]).toEqual([5, 5]);

    act(() => root.render(createElement(Host, { commit, multiline: true, key: "wrap" })));
    act(() => document.querySelector("button")!.click());
    const field = document.querySelector<HTMLTextAreaElement>("textarea.rename-input.rename-input--multiline")!;
    expect(field.value).toBe("Draft");
    // Focused, the caret at the end — where a rename goes on from.
    expect(document.activeElement).toBe(field);
    expect([field.selectionStart, field.selectionEnd]).toEqual([5, 5]);
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    act(() => void field.dispatchEvent(enter));
    expect(enter.defaultPrevented).toBe(true);
    expect(commit).toHaveBeenCalledWith("k", "Draft", "Draft");
  });
});
