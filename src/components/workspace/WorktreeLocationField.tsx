/**
 * WHERE the team will run: the worktree path, what the app makes of it, and
 * the branch a new one is created on.
 *
 * A field of its own because it is a feature of its own — see
 * [`useWorktreeLocation`], which holds its mind. The dialog composes it and
 * reads back a location; it does not own a probe, a branch listing or the
 * deck's word on a directory.
 */
import { Combobox } from "@keepdeck/ui-kit/Combobox";
import { NextIcon } from "../../ui/icons";
import { SuggestedInput } from "../../ui/SuggestedInput";
import { classifyLocation, type PathProbe } from "../../domain/agents";
import type { WorktreeLocation } from "./useWorktreeLocation";

export function WorktreeLocationField({
  location,
  repoBranch,
  suggestedPath,
}: {
  location: WorktreeLocation;
  /** The repo's current branch, for the "runs in the main repo" hint. */
  repoBranch: string | null;
  suggestedPath: string;
}) {
  const {
    path,
    setPath,
    branch,
    setBranch,
    baseBranch,
    setBaseBranch,
    branches,
    derivedBranch,
    probe,
    kind,
    layoutKind,
    baseOk,
    useNextFree,
    choosePath,
  } = location;
  return (
      <>
        <span className="form__label">Worktree</span>
        <div className="form__path">
          <SuggestedInput
            value={path}
            suggestion={suggestedPath}
            onChange={setPath}
            className="form__path-field"
            placeholder="Empty = main repo · a path = worktree"
            ariaLabel="Worktree path"
            clearTitle="Clear — run in the main repo"
            resetTitle="Reset to the suggested path"
          />
          <button type="button" className="form__dir-btn" onClick={choosePath}>
            Choose…
          </button>
        </div>
        <LocationHint
          kind={kind}
          repoBranch={repoBranch}
          probe={probe}
          onUseNext={useNextFree}
        />

        {layoutKind === "new" && (
          <>
            <span className="form__label">Branch</span>
            <SuggestedInput
              value={branch}
              suggestion={derivedBranch}
              onChange={setBranch}
              className="form__field--gap"
              ariaLabel="Branch name"
              resetTitle="Reset to the suggested branch"
            />
            {!branch.trim() && (
              <span className="form__error">Branch is required</span>
            )}

            <span className="form__label">Base branch</span>
            <Combobox
              options={branches ?? []}
              value={baseBranch}
              onChange={setBaseBranch}
              className="form__field--gap"
              ariaLabel="Base branch"
            />
            {!baseOk && (
              <span className="form__error">No such local branch</span>
            )}
          </>
        )}
      </>
  );
}


/** The live hint under the worktree field: what the current path will do.
 * The unusable states are a choice, not a dead end — an inline action lets
 * the user jump to the next free path. A directory another TEAM works in is
 * not one of them: teams share a directory when the person says so, and that
 * question is asked on the way out, by the create that knows whose it is. */
function LocationHint({
  kind,
  repoBranch,
  probe,
  onUseNext,
}: {
  kind: ReturnType<typeof classifyLocation>;
  repoBranch: string | null;
  probe: PathProbe | null;
  onUseNext(): void;
}) {
  switch (kind) {
    case "main":
      return (
        <span className="form__git">
          ✓ Runs in the main repo{repoBranch ? ` · ${repoBranch}` : ""}
        </span>
      );
    case "checking":
      return <span className="form__git">Checking path…</span>;
    case "new":
      return <span className="form__git">✓ New worktree on a new branch</span>;
    case "existing":
      return (
        <span className="form__git">
          ✓ Attach to existing worktree
          {probe?.branch ? ` · ${probe.branch}` : ""}
        </span>
      );
    case "occupied":
      return (
        <>
          <span className="form__error">
            A worktree is still being created there
          </span>
          <div className="form__choices">
            <button
              type="button"
              className="form__choice"
              onClick={onUseNext}
              title="Use next available"
              aria-label="Use next available"
            >
              <NextIcon />
            </button>
          </div>
        </>
      );
    case "blocked":
      return (
        <>
          <span className="form__error">
            Folder has files and isn't a worktree — pick a new or empty folder
          </span>
          <div className="form__choices">
            <button
              type="button"
              className="form__choice"
              onClick={onUseNext}
              title="Use next available"
              aria-label="Use next available"
            >
              <NextIcon />
            </button>
          </div>
        </>
      );
  }
}
