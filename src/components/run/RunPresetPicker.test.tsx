// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunPresetPicker } from "./RunPresetPicker";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PRESETS = [
  { id: "run-1", name: "Dev", command: "pnpm dev" },
  { id: "run-2", name: "Worker", command: "pnpm worker" },
];

const noop = () => {};
const baseProps = {
  presets: PRESETS,
  onPick: noop,
  onAdHoc: noop,
  onDelete: noop,
  onCancel: noop,
};

/** Type into a controlled input (native setter + bubbling input event). */
function type(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(el),
    "value",
  )!.set!;
  act(() => {
    set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const commandInput = () =>
  document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Command to run"]',
  )!;
const submit = () =>
  act(() => {
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

describe("RunPresetPicker", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("lists the presets and runs one on click", () => {
    const onPick = vi.fn();
    act(() =>
      root.render(createElement(RunPresetPicker, { ...baseProps, onPick })),
    );

    const rows = document.querySelectorAll<HTMLButtonElement>(".run__preset-run");
    expect(Array.from(rows).map((r) => r.textContent)).toEqual([
      "Devpnpm dev",
      "Workerpnpm worker",
    ]);
    act(() => rows[1].click());
    expect(onPick).toHaveBeenCalledWith(PRESETS[1]);
  });

  it("the row's ✕ deletes the preset without running it", () => {
    const onPick = vi.fn();
    const onDelete = vi.fn();
    act(() =>
      root.render(
        createElement(RunPresetPicker, { ...baseProps, onPick, onDelete }),
      ),
    );

    act(() =>
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Delete preset Dev"]')!
        .click(),
    );
    expect(onDelete).toHaveBeenCalledWith("run-1");
    expect(onPick).not.toHaveBeenCalled();
  });

  it("runs an ad-hoc command without saving by default", () => {
    const onAdHoc = vi.fn();
    act(() =>
      root.render(createElement(RunPresetPicker, { ...baseProps, onAdHoc })),
    );

    type(commandInput(), "  go run ./cmd/server  ");
    submit();
    expect(onAdHoc).toHaveBeenCalledWith("go run ./cmd/server", null);
  });

  it("the command is multi-line: Enter stays in the field, ⌘⏎ runs", () => {
    const onAdHoc = vi.fn();
    act(() =>
      root.render(createElement(RunPresetPicker, { ...baseProps, onAdHoc })),
    );

    type(commandInput(), "export FOO=1\npnpm dev");
    act(() => {
      commandInput().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(onAdHoc).not.toHaveBeenCalled();

    act(() => {
      commandInput().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          metaKey: true,
          bubbles: true,
        }),
      );
    });
    expect(onAdHoc).toHaveBeenCalledWith("export FOO=1\npnpm dev", null);
  });

  it("Save as preset reveals the name field and passes it through", () => {
    const onAdHoc = vi.fn();
    act(() =>
      root.render(createElement(RunPresetPicker, { ...baseProps, onAdHoc })),
    );
    expect(document.querySelector('input[aria-label="Preset name"]')).toBeNull();

    act(() =>
      document
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!
        .click(),
    );
    type(
      document.querySelector<HTMLInputElement>('input[aria-label="Preset name"]')!,
      "Server",
    );
    type(commandInput(), "go run ./cmd/server");
    submit();
    expect(onAdHoc).toHaveBeenCalledWith("go run ./cmd/server", "Server");
  });

  it("Run stays disabled until a command is typed", () => {
    const onAdHoc = vi.fn();
    act(() =>
      root.render(createElement(RunPresetPicker, { ...baseProps, onAdHoc })),
    );

    const run = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Run",
    )!;
    expect(run.disabled).toBe(true);
    submit();
    expect(onAdHoc).not.toHaveBeenCalled();
  });
});
