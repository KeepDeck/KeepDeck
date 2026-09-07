/**
 * The host the skills dialog suites render into: the library double whose
 * writes LAND in its list (the way the real hook's re-read makes them), the
 * settings singleton the bundled hint reads, and a mount that counts closes.
 *
 * Every suite imports THIS before the dialog: the doubles register when this
 * module evaluates, and the dialog would pull the real hooks in first.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";
import {
  composeSkillFile,
  sameSkillRef,
  type SkillDraft,
  type SkillScope,
} from "../../domain/skills";
import type { LibrarySkill } from "../../app/skillsLibrary";
import type { Settings } from "../../domain/settings";
import type { SkillsEditorState } from "../../app/useSkills";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** A row as the library would hold it after the write landed. */
const landed = (scope: SkillScope, draft: SkillDraft): LibrarySkill => ({
  scope,
  name: draft.name,
  content: composeSkillFile(draft),
});

// ANNOTATED, like the sibling double in useSkills.test.ts: an added field on
// `SkillsEditorState` must fail to compile HERE rather than reach the component
// as `undefined` in every case. Hoisted because a `vi.mock` factory's double
// has to exist before imports are initialized.
const hoistedLib = vi.hoisted(
  () =>
    ({
      skills: [] as LibrarySkill[] | null,
      error: null as string | null,
      // Widened so a case can flip it: the literal would narrow to `true`.
      listTrusted: true as boolean,
      clearError: vi.fn(),
      // The writes LAND IN THE LIST: the real hook awaits a refresh before it
      // resolves, so by the time the dialog sees `true` the row is there. A
      // double that resolved true and left the list alone was a state
      // production cannot produce, and the dialog — which notices a selection
      // missing from the library — read it as the skill having been deleted.
      save: vi.fn(async (scope: SkillScope, draft: SkillDraft, mode: "create" | "update") => {
        hoistedLib.skills =
          mode === "create"
            ? [...(hoistedLib.skills ?? []), landed(scope, draft)]
            : (hoistedLib.skills ?? []).map((s) =>
                sameSkillRef(s, { scope, name: draft.name }) ? landed(scope, draft) : s,
              );
        return true;
      }),
      rename: vi.fn(async (scope: SkillScope, from: string, to: string) => {
        hoistedLib.skills = (hoistedLib.skills ?? []).map((s) =>
          sameSkillRef(s, { scope, name: from }) ? { ...s, name: to } : s,
        );
        return true;
      }),
      remove: vi.fn(async (scope: SkillScope, name: string) => {
        hoistedLib.skills = (hoistedLib.skills ?? []).filter((s) => !sameSkillRef(s, { scope, name }));
        return true;
      }),
    }) satisfies SkillsEditorState,
);
vi.mock("../../app/useSkills", () => ({ useSkillsLibrary: () => hoistedLib }));
export const lib = hoistedLib;

// The settings singleton the bundled panel's unlock hint reads (the hint
// keys on the artifacts SETTING, by the design's divergence ruling).
const hoistedSettings = vi.hoisted(() => ({ current: null as Settings | null }));
vi.mock("../../app/useSettings", () => ({
  useSettings: () => hoistedSettings.current,
}));
export const settingsState = hoistedSettings;

export const skill = (
  name: string,
  scope: "global" | "workspace" = "global",
  wsId = "",
): LibrarySkill => ({
  scope: scope === "global" ? { kind: "global" } : { kind: "workspace", wsId },
  name,
  content: `---\nname: ${name}\ndescription: About ${name}\n---\nBody of ${name}\n`,
});

export const bundled = (name: string, content = skill(name).content): LibrarySkill => ({
  scope: { kind: "bundled" },
  name,
  content,
});

export const WS = { id: "ws-1", name: "My project" };

/** A mounted dialog for one suite: `setup` in beforeEach, `teardown` in
 * afterEach. `mockClear` only on the writes — NOT `mockResolvedValue`, which
 * would replace the implementations above with ones that leave the list
 * untouched, i.e. put the double back in a state the real hook cannot be
 * in. A case that wants a failure says so with `mockResolvedValueOnce`. */
export function skillsDialogHost(Dialog: (props: {
  activeWs: { id: string; name: string } | null;
  onClose(): void;
}) => unknown) {
  let root: Root;
  let closed = 0;
  return {
    setup() {
      lib.skills = [];
      lib.error = null;
      lib.listTrusted = true;
      settingsState.current = null;
      lib.clearError.mockClear();
      lib.save.mockClear();
      lib.rename.mockClear();
      lib.remove.mockClear();
      document.body.innerHTML = "<div id='host'></div>";
      root = createRoot(document.getElementById("host")!);
      closed = 0;
    },
    teardown() {
      act(() => root.unmount());
    },
    /** Render (or re-render, after the double's list moved). */
    mount: (activeWs: { id: string; name: string } | null = WS) =>
      act(async () =>
        root.render(createElement(Dialog as never, { activeWs, onClose: () => closed++ })),
      ),
    closed: () => closed,
  };
}
