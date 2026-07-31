// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useInlineRename, type InlineRename } from "./useInlineRename";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let api: InlineRename;
let commit: ReturnType<typeof vi.fn>;

function Probe() {
  api = useInlineRename(commit as (key: string, name: string) => void);
  return null;
}

describe("useInlineRename", () => {
  let root: Root;

  beforeEach(() => {
    commit = vi.fn();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });
  afterEach(() => {
    act(() => root.unmount());
  });

  it("start seeds the draft with the current name", () => {
    act(() => api.start("ws-1", "my-api"));
    expect(api.editing).toBe("ws-1");
    expect(api.inputProps.value).toBe("my-api");
  });

  it("Enter commits the trimmed draft against the edited key and leaves edit mode", () => {
    act(() => api.start("ws-1", "old"));
    act(() => api.inputProps.onChange({ target: { value: "  new name  " } }));
    act(() => api.inputProps.onKeyDown({ key: "Enter" }));
    expect(commit).toHaveBeenCalledWith("ws-1", "new name");
    expect(api.editing).toBeNull();
  });

  it("an emptied draft still commits — empty means reset-to-auto, not keep-old", () => {
    // The two hand-rolled widgets disagreed here: the pane reset, the rail
    // silently kept the old name. The contract is committed once, in the hook.
    act(() => api.start("ws-1", "old"));
    act(() => api.inputProps.onChange({ target: { value: "   " } }));
    act(() => api.inputProps.onBlur());
    expect(commit).toHaveBeenCalledWith("ws-1", "");
  });

  it("Escape cancels without committing", () => {
    act(() => api.start("ws-1", "old"));
    act(() => api.inputProps.onChange({ target: { value: "typed" } }));
    act(() => api.inputProps.onKeyDown({ key: "Escape" }));
    expect(commit).not.toHaveBeenCalled();
    expect(api.editing).toBeNull();
  });

  it("blur commits exactly once; a later blur without an edit session is a no-op", () => {
    act(() => api.start("ws-1", "old"));
    act(() => api.inputProps.onBlur());
    act(() => api.inputProps.onBlur());
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
