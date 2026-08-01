// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useModalRouter } from "./useModalRouter";

type Router = ReturnType<typeof useModalRouter>;

function Harness({
  transactionOpen,
  out,
}: {
  transactionOpen: boolean;
  out: { current: Router | null };
}) {
  out.current = useModalRouter({ transactionOpen });
  return null;
}

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

function mount() {
  const out = { current: null as Router | null };
  root = createRoot(document.createElement("div"));
  const render = (transactionOpen: boolean) =>
    act(() => root!.render(createElement(Harness, { transactionOpen, out })));
  render(false);
  const router = () => out.current!;
  return { render, router };
}

describe("useModalRouter", () => {
  it("holds one dialog at a time and refuses to open over a transaction", () => {
    const { render, router } = mount();
    let opened = false;
    act(() => {
      opened = router().openSettings("updates");
    });
    expect(opened).toBe(true);
    expect(router().settingsOpen).toBe(true);
    expect(router().settingsSection).toBe("updates");

    act(() => {
      opened = router().openSkills();
    });
    expect(opened).toBe(false); // settings already up
    act(() => router().closeSettings());
    expect(router().settingsOpen).toBe(false);
    expect(router().settingsSection).toBeUndefined();

    render(true); // a confirm/alert is up
    act(() => {
      opened = router().openStats();
    });
    expect(opened).toBe(false);
  });

  it("leaves Escape to the transaction: close verbs no-op while one is up", () => {
    const { render, router } = mount();
    act(() => void router().openStats("achievements"));
    expect(router().statsOpen).toBe(true);

    // An alert pops over the dialog. One Escape press runs BOTH stacked
    // useEscape handlers; the dialog's close must yield to the alert.
    render(true);
    act(() => router().closeStats());
    expect(router().statsOpen).toBe(true);
    expect(router().statsTab).toBe("achievements"); // nothing lost

    render(false); // alert dismissed
    act(() => router().closeStats());
    expect(router().statsOpen).toBe(false);
    expect(router().statsTab).toBe("overview");
  });

  it("retargets an already-open stats dialog instead of swallowing a deep link", () => {
    const { router } = mount();
    act(() => void router().openStats());
    expect(router().statsTab).toBe("overview");
    let result = false;
    act(() => {
      result = router().openStats("providers");
    });
    expect(result).toBe(true);
    expect(router().statsTab).toBe("providers");
  });
});
