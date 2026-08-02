// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPaneInputFocusController } from "./paneInputFocusController";
import type { PaneInputFocusSource } from "./paneInputFocusController";
import { usePaneInputFocus } from "./usePaneInputFocus";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

interface ProbeProps {
  controller: PaneInputFocusSource;
  paneId: string;
  active: boolean;
  inputVersion: number;
  focusInput: () => void;
}

function Probe(props: ProbeProps) {
  usePaneInputFocus(
    props.controller,
    props.paneId,
    props.active,
    props.inputVersion,
    props.focusInput,
  );
  return null;
}

function render(props: ProbeProps) {
  root ??= createRoot(document.createElement("div"));
  act(() => root!.render(createElement(Probe, props)));
}

describe("usePaneInputFocus", () => {
  it("consumes only the read-side focus source role", () => {
    const controller = createPaneInputFocusController();
    const source: PaneInputFocusSource = {
      subscribe: controller.subscribe,
      getSnapshot: controller.getSnapshot,
    };
    const focusInput = vi.fn();

    render({
      controller: source,
      paneId: "pane-1",
      active: true,
      inputVersion: 1,
      focusInput,
    });

    expect(focusInput).toHaveBeenCalledOnce();
  });

  it("focuses when the selected pane becomes active or rebuilds its input", () => {
    const controller = createPaneInputFocusController();
    const focusInput = vi.fn();
    const props = { controller, paneId: "pane-1", focusInput };

    render({ ...props, active: false, inputVersion: 0 });
    render({ ...props, active: true, inputVersion: 1 });
    render({ ...props, active: true, inputVersion: 2 });

    expect(focusInput).toHaveBeenCalledTimes(2);
  });

  it("handles repeated explicit requests without reacting to another pane", () => {
    const controller = createPaneInputFocusController();
    const focusInput = vi.fn();
    render({
      controller,
      paneId: "pane-1",
      active: true,
      inputVersion: 1,
      focusInput,
    });
    focusInput.mockClear();

    act(() => controller.requestFocus("pane-1"));
    act(() => controller.requestFocus("pane-1"));
    act(() => controller.requestFocus("pane-2"));

    expect(focusInput).toHaveBeenCalledTimes(2);
  });

  it("defers a request until its pane is active", () => {
    const controller = createPaneInputFocusController();
    const focusInput = vi.fn();
    const props = {
      controller,
      paneId: "pane-1",
      inputVersion: 1,
      focusInput,
    };
    render({ ...props, active: false });

    act(() => controller.requestFocus("pane-1"));
    expect(focusInput).not.toHaveBeenCalled();

    render({ ...props, active: true });
    expect(focusInput).toHaveBeenCalledOnce();
  });
});
