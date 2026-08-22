// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibrarySkill } from "../../app/skillsLibrary";
import type { Settings } from "../../domain/settings";
import { sameSkillRef, type SkillScope } from "../../domain/skills";
import { useSkillsEditor } from "./useSkillsEditor";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const skill = (name: string): LibrarySkill => ({
  scope: { kind: "global" },
  name,
  content: `---\nname: ${name}\ndescription: About ${name}\n---\nBody\n`,
});

/** Writes that never settle on their own — the tests release them, which
 * is how a second click lands while the first is still inside. */
const pending: Array<(ok: boolean) => void> = [];
const settleNext = (ok = true) => pending.shift()?.(ok);
const held = () => new Promise<boolean>((res) => pending.push(res));

const lib = vi.hoisted(() => ({
  skills: null as LibrarySkill[] | null,
  error: null as string | null,
  listTrusted: true,
  clearError: vi.fn(),
  save: vi.fn(),
  rename: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("../../app/useSkills", () => ({ useSkillsLibrary: () => lib }));

const settingsState = vi.hoisted(() => ({ current: null as Settings | null }));
vi.mock("../../app/useSettings", () => ({
  useSettings: () => settingsState.current,
}));

let editor: ReturnType<typeof useSkillsEditor>;
let closed = 0;
let host: HTMLDivElement;
let root: Root;

function Probe() {
  editor = useSkillsEditor({
    activeWs: { id: "ws-1", name: "KeepDeck" },
    onClose: () => {
      closed += 1;
    },
    canClose: true,
  });
  return null;
}

const mount = () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(Probe)));
};

/** Put a bundled row in the library and let the machine SEE it — a
 * mutation alone leaves the current render holding the old list. */
const withBundled = () => {
  lib.skills = [
    ...(lib.skills ?? []),
    {
      scope: { kind: "bundled" },
      name: "artifacts",
      content: "---\nname: artifacts\ndescription: d\n---\nB\n",
    },
  ];
  act(() => root.render(createElement(Probe)));
};

/** Open `name` and type into its body, so the draft is dirty and savable. */
const openDirty = (name: string) => {
  act(() => editor.navigate({ mode: "edit", scope: { kind: "global" }, name }));
  act(() => editor.onField("body", "edited"));
};

beforeEach(() => {
  pending.length = 0;
  closed = 0;
  lib.skills = [skill("deploy"), skill("review")];
  lib.error = null;
  lib.listTrusted = true;
  lib.clearError.mockReset();
  lib.save.mockReset().mockImplementation(held);
  lib.rename.mockReset().mockImplementation(held);
  lib.remove.mockReset().mockImplementation(held);
  settingsState.current = null;
  mount();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("re-entrancy — the latches, at the machine's own level", () => {
  it("a second submit in the SAME TICK does not start a second write", async () => {
    // The dialog suite proves this through two ⌘S keystrokes; here it is
    // the contract itself, so the hook keeps the guarantee even if no
    // keyboard ever reaches it. A rename is not idempotent — replaying
    // it after the first consumed the old name paints a failure over a
    // rename that worked.
    openDirty("deploy");
    act(() => editor.onField("name", "deployed"));
    await act(async () => {
      void editor.submit();
      void editor.submit();
    });
    expect(lib.rename).toHaveBeenCalledTimes(1);
  });

  it("a save cannot start while a delete is in flight", async () => {
    openDirty("deploy");
    act(() => editor.requestDelete());
    act(() => editor.confirmDelete());
    await act(async () => {
      void editor.submit();
    });
    expect(lib.save).not.toHaveBeenCalled();
    await act(async () => settleNext(true));
  });

  it("releases the latch when the write settles, so the next save runs", async () => {
    openDirty("deploy");
    await act(async () => {
      void editor.submit();
      settleNext(true);
    });
    act(() => editor.onField("body", "again"));
    await act(async () => {
      void editor.submit();
      settleNext(true);
    });
    expect(lib.save).toHaveBeenCalledTimes(2);
  });
});

describe("the write machine is blind to the read-only tier", () => {
  it("a bundled row offers no save at all", () => {
    withBundled();
    act(() => editor.navigate({ mode: "view", name: "artifacts" }));
    expect(editor.verdicts.isView).toBe(true);
    expect(editor.verdicts.canSave).toBe(false);
  });

  it("submitting on a bundled row writes nothing", async () => {
    withBundled();
    act(() => editor.navigate({ mode: "view", name: "artifacts" }));
    await act(async () => {
      void editor.submit();
    });
    expect(lib.save).not.toHaveBeenCalled();
    expect(lib.rename).not.toHaveBeenCalled();
  });
});

describe("the vanished verdict has ONE computation", () => {
  it("an ordinary save lands as an UPDATE and says so to the library", () => {
    // The baseline the next test is measured against: while the skill is
    // on disk, the write machine calls it an update.
    openDirty("deploy");
    act(() => {
      void editor.submit();
    });
    expect(lib.save).toHaveBeenCalledWith(
      { kind: "global" },
      expect.objectContaining({ name: "deploy" }),
      "update",
    );
  });

  it("the gate and the write machine never disagree about a vanished skill", () => {
    // THE protection, stated as behaviour: the verdict is computed once
    // and both consumers read it. The gate refuses, and because it
    // refuses, the write machine is never entered at all — a second
    // opinion downstream is what would let a doomed update through while
    // the button claimed it was impossible.
    openDirty("deploy");
    act(() => {
      lib.skills = [skill("review")];
      root.render(createElement(Probe));
    });
    expect(editor.verdicts.vanished).toBe(true);
    expect(editor.verdicts.canSave).toBe(false);
    act(() => {
      void editor.submit();
    });
    expect(lib.save).not.toHaveBeenCalled();
    expect(lib.rename).not.toHaveBeenCalled();
  });

  it("keeps the user's text on screen — a refused save is not a discard", () => {
    // Throwing away what they typed is the one thing worse than a stale
    // editor, so the draft survives the disappearance.
    openDirty("deploy");
    act(() => {
      lib.skills = [skill("review")];
      root.render(createElement(Probe));
    });
    expect(editor.form.body).toBe("edited");
    expect(editor.selection?.mode).toBe("edit");
  });
});

describe("the confirm belongs to the machine", () => {
  it("navigating away drops a confirm that named where the user WAS", () => {
    openDirty("deploy");
    act(() => editor.requestDelete());
    expect(editor.confirm?.kind).toBe("delete");
    act(() => editor.confirmDiscard());
    // Not the discard flow's dialog — a delete confirm answered by the
    // wrong button must not fire a write.
    expect(lib.remove).not.toHaveBeenCalled();
  });

  it("a discard confirm guards unsaved edits and then moves", () => {
    openDirty("deploy");
    act(() => editor.navigate({ mode: "edit", scope: { kind: "global" }, name: "review" }));
    expect(editor.confirm?.kind).toBe("discard");
    act(() => editor.confirmDiscard());
    expect(
      editor.selection?.mode === "edit" &&
        sameSkillRef(editor.selection, {
          scope: { kind: "global" } as SkillScope,
          name: "review",
        }),
    ).toBe(true);
  });

  it("closing through the confirm reaches onClose exactly once", () => {
    openDirty("deploy");
    act(() => editor.navigate(null, true));
    expect(closed).toBe(0);
    act(() => editor.confirmDiscard());
    expect(closed).toBe(1);
  });
});

describe("the unlock hint rides the controller", () => {
  it("is present while the artifacts setting is off", () => {
    act(() => {
      settingsState.current = { artifacts: false } as Settings;
      root.render(createElement(Probe));
    });
    expect(editor.viewHint).toContain("artifacts experiment");
  });

  it("is absent while it is on, and absent while it is unread", () => {
    act(() => {
      settingsState.current = { artifacts: true } as Settings;
      root.render(createElement(Probe));
    });
    expect(editor.viewHint).toBeUndefined();
    act(() => {
      settingsState.current = null;
      root.render(createElement(Probe));
    });
    expect(editor.viewHint).toBeUndefined();
  });
});
