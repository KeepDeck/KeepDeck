import { useEffect, useState } from "react";
import {
  removeStoredRole,
  saveStoredRole,
} from "../../app/roleCatalogManager";
import { useRoleCatalog } from "../../app/useRoleCatalog";
import { useSettings } from "../../app/useSettings";
import {
  builtInRoles,
  roleIdProblem,
  roleTextsProblem,
  teamRoles,
  type StoredRole,
  type TeamRole,
} from "../../domain/mail";
import { DEFAULT_SETTINGS } from "../../domain/settings";
import { describeError } from "../../ipc/log";
import { noAutoCorrect } from "../../ui/inputProps";

/** What the form holds while the person types. The charter travels as ONE
 * text here — a paragraph per line — because that is what a textarea is;
 * it becomes the domain's list at the door. */
interface RoleDraft {
  id: string;
  label: string;
  summary: string;
  charter: string;
  repeatable: boolean;
  standing: "reports" | "peer";
}

type Selection = { kind: "edit"; id: string } | { kind: "create" };

const draftOf = (role: TeamRole): RoleDraft => ({
  id: role.id,
  label: role.label,
  summary: role.summary,
  charter: role.charter.join("\n"),
  repeatable: role.repeatable,
  standing: role.standing === "peer" ? "peer" : "reports",
});

const FRESH: RoleDraft = {
  id: "",
  label: "",
  summary: "",
  charter: "",
  repeatable: true,
  standing: "reports",
};

/**
 * Team roles — the catalog behind the team dialog's picker and every
 * briefing, editable. A built-in role opens on its CURRENT texts (edits
 * included) and saves only texts; a role of the user's own carries its
 * standing and repeatability too. All rules are the domain's, asked
 * through `roleIdProblem` / `roleTextsProblem`, so this form refuses in
 * exactly the words the file merge would; the writes go through the
 * catalog manager, which re-installs the catalog and re-briefs live
 * teams — nothing here does either.
 */
export function TeamRolesSection() {
  const settings = useSettings();
  const agentTeams = settings?.agentTeams ?? DEFAULT_SETTINGS.agentTeams;
  const catalog = useRoleCatalog();
  const [selected, setSelected] = useState<Selection | null>(null);
  const [draft, setDraft] = useState<RoleDraft | null>(null);
  /** Whether the person has TYPED into the draft — the line between a seed
   * that follows a late-loading catalog and words that are theirs. */
  const [dirty, setDirty] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Fresh on every render: the catalog notification that re-rendered this
  // section is the same one that re-installed the list.
  const roles = teamRoles();
  const builtinIds = new Set(builtInRoles().map((role) => role.id));
  // Stored records the merge could not turn into a role — a broken custom
  // file. Listed so the one thing left to do with it stays reachable.
  const orphans = [...catalog.storedIds].filter(
    (id) => !builtinIds.has(id) && !roles.some((role) => role.id === id),
  );

  const open = (role: TeamRole) => {
    setSelected({ kind: "edit", id: role.id });
    setDraft(draftOf(role));
    setDirty(false);
    setProblem(null);
  };
  const close = () => {
    setSelected(null);
    setDraft(null);
    setDirty(false);
    setProblem(null);
  };
  const edit = (patch: Partial<RoleDraft>) => {
    setDirty(true);
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };

  // The catalog can land or change UNDER an open editor — the boot load
  // resolving late, another surface saving. An UNTOUCHED draft follows it:
  // seeded from the pre-load built-ins and saved, it would overwrite
  // stored texts the user never saw. A draft they typed into is theirs and
  // stays; a role deleted underneath closes the editor.
  useEffect(() => {
    if (dirty || selected?.kind !== "edit") return;
    const role = teamRoles().find((candidate) => candidate.id === selected.id);
    if (role) setDraft(draftOf(role));
    else close();
  }, [catalog, dirty, selected]);

  const creating = selected?.kind === "create";
  const isCustom =
    creating || (selected?.kind === "edit" && !builtinIds.has(selected.id));

  const submit = async () => {
    if (!draft || !selected || busy) return;
    const id = selected.kind === "edit" ? selected.id : draft.id.trim().toLowerCase();
    // The same demands the file merge makes, asked before anything is
    // written — plus the one rule only this gesture has: a CREATE must not
    // silently become an edit of a role that already exists.
    const record: StoredRole = {
      label: draft.label.trim(),
      summary: draft.summary.trim(),
      charter: draft.charter
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
      ...(isCustom ? { repeatable: draft.repeatable, standing: draft.standing } : {}),
    };
    const refused =
      (selected.kind === "create"
        ? (roleIdProblem(id) ??
          (roles.some((role) => role.id === id)
            ? `"${id}" is already a role this deck knows`
            : null))
        : null) ?? roleTextsProblem(record);
    if (refused) {
      setProblem(refused);
      return;
    }
    setBusy(true);
    try {
      await saveStoredRole(id, record);
      close();
    } catch (e) {
      setProblem(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  /** One verb for both gestures the record's absence means: a built-in's
   * reset to defaults, a custom role's removal. */
  const removeRecord = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await removeStoredRole(id);
      // Close only the editor this deletion is ABOUT: an orphan's Delete
      // beside an open, unrelated draft must not discard that draft.
      if (selected?.kind === "edit" && selected.id === id) close();
      else setProblem(null);
    } catch (e) {
      setProblem(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <span className="form__label">Team roles</span>
      <span className="settings__hint">
        A role is a team member's address AND the words the deck briefs it
        with. Edit a built-in role's texts, or add roles of your own — each
        is a file under KeepDeck's home, and deleting the file restores the
        default.
      </span>
      {!agentTeams && (
        <span className="settings__hint">
          Agent teams is off (see Experimental) — roles take effect once it
          is on.
        </span>
      )}

      {catalog.problems.length > 0 && (
        // The person reading this is the one who can fix the file, so the
        // refusals arrive verbatim — the same words the merge produced.
        <span className="settings__hint kd-selectable">
          Problems with the stored role files:
          {catalog.problems.map((refusal) => (
            <span key={refusal} className="settings__refusal">
              {refusal}
            </span>
          ))}
        </span>
      )}

      <ul className="roles__list">
        {roles.map((role) => (
          <li key={role.id}>
            <button
              type="button"
              className={`roles__row${
                selected?.kind === "edit" && selected.id === role.id
                  ? " roles__row--active"
                  : ""
              }`}
              onClick={() => open(role)}
            >
              <span className="roles__row-label">{role.label}</span>
              <span className="roles__row-id">{role.id}</span>
              <span className="roles__row-standing">{role.standing}</span>
              {builtinIds.has(role.id) ? (
                catalog.storedIds.has(role.id) && (
                  <span className="roles__row-note">edited</span>
                )
              ) : (
                <span className="roles__row-note">yours</span>
              )}
            </button>
          </li>
        ))}
        {orphans.map((id) => (
          <li key={id} className="roles__orphan">
            <span className="roles__row-id">{id}</span>
            <span className="roles__row-note">unreadable — see above</span>
            <button
              type="button"
              className="form__cancel"
              disabled={busy}
              onClick={() => void removeRecord(id)}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>

      {problem && (
        // Rendered OUTSIDE the editor: an orphan's failed deletion has no
        // editor open, and an error set into hidden state is a button that
        // just did nothing.
        <p className="form__error roles__error" role="alert">
          ⚠ {problem}
        </p>
      )}

      {draft && selected ? (
        <div className="roles__editor">
          {selected.kind === "create" && (
            <>
              <span className="form__label">Id</span>
              <input
                {...noAutoCorrect}
                className="form__input"
                value={draft.id}
                onChange={(e) => edit({ id: e.target.value })}
                placeholder="e.g. docs"
                aria-label="Role id"
              />
              <span className="settings__hint">
                The address teammates write to — lowercase, dashes allowed,
                and no numbered tail (that is how holders are counted).
              </span>
            </>
          )}
          <span className="form__label">Label</span>
          <input
            {...noAutoCorrect}
            className="form__input"
            value={draft.label}
            onChange={(e) => edit({ label: e.target.value })}
            aria-label="Role label"
          />
          <span className="form__label">Summary</span>
          <input
            {...noAutoCorrect}
            className="form__input"
            value={draft.summary}
            onChange={(e) => edit({ summary: e.target.value })}
            aria-label="Role summary"
          />
          <span className="settings__hint">
            One line the OTHER members see in their roster, beside this
            role's address.
          </span>
          <span className="form__label">Charter</span>
          <textarea
            className="form__input roles__charter"
            value={draft.charter}
            onChange={(e) => edit({ charter: e.target.value })}
            rows={6}
            aria-label="Role charter"
          />
          <span className="settings__hint">
            Told to the role's HOLDER, a paragraph per line. Say what it
            does not do as well — that is the half an agent invents when it
            is not said.
          </span>
          {isCustom && (
            <>
              <span className="form__label">Standing</span>
              <div className="form__types">
                {(
                  [
                    ["reports", "Works under the lead"],
                    ["peer", "A peer — flat teams only"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={`form__type${draft.standing === value ? " form__type--active" : ""}`}
                    disabled={!creating}
                    onClick={() => edit({ standing: value })}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label className="roles__repeatable">
                <input
                  type="checkbox"
                  checked={draft.repeatable}
                  disabled={!creating}
                  onChange={(e) => edit({ repeatable: e.target.checked })}
                />
                a team may hold several ({draft.id.trim() || "role"}-1,{" "}
                {draft.id.trim() || "role"}-2, …)
              </label>
              {!creating && (
                // The rules run on these, and live teams were planned
                // against them: flipped underneath, a led team's member
                // would be refused as "flat" while its briefing still
                // names the lead. Text stays editable; shape does not.
                <span className="settings__hint">
                  Standing and repeatability are set at creation — the team
                  rules run on them. Delete the role and recreate it to
                  change them.
                </span>
              )}
            </>
          )}
          <div className="form__actions roles__actions">
            {selected.kind === "edit" &&
              builtinIds.has(selected.id) &&
              catalog.storedIds.has(selected.id) && (
                <button
                  type="button"
                  className="form__cancel"
                  disabled={busy}
                  onClick={() => void removeRecord(selected.id)}
                >
                  Reset to default
                </button>
              )}
            {selected.kind === "edit" && !builtinIds.has(selected.id) && (
              <button
                type="button"
                className="form__cancel"
                disabled={busy}
                onClick={() => void removeRecord(selected.id)}
              >
                Delete role
              </button>
            )}
            <button type="button" className="form__cancel" onClick={close}>
              Close
            </button>
            <button
              type="button"
              className="form__create"
              disabled={busy || !catalog.writable}
              onClick={() => void submit()}
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="form__types">
          {/* Declined up front when this session cannot save (the boot
              read failed): a form that can only fail on submit invites the
              gesture it will refuse — the problems banner says why. */}
          <button
            type="button"
            className="form__type"
            disabled={!catalog.writable}
            onClick={() => {
              setSelected({ kind: "create" });
              setDraft(FRESH);
              setProblem(null);
            }}
          >
            + Add role
          </button>
        </div>
      )}
    </>
  );
}
