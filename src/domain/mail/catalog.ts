/**
 * The user's half of the role catalog: stored records merged over the
 * built-ins.
 *
 * One mechanism serves both wants. A record whose id names a BUILT-IN role
 * is an edit of its texts — label, summary, charter — and nothing else:
 * `repeatable` and `standing` are what the rules run on, so a file may
 * rewrite what a role SAYS but never what it IS. A record with a new id is
 * a role of the user's own. Deleting the record is the reset, in both
 * cases — which is why there is no separate "overrides" model to keep in
 * step with this one.
 *
 * Everything here is pure and IO-free. What lies on disk, and when, is the
 * role catalog manager's business; this module answers what those bytes
 * MEAN, and refuses the ones that mean nothing in words a person can act
 * on. A bad record costs only itself: the merge always answers with a
 * whole catalog, because a typo in one file must not take the teams
 * feature down with it.
 */
import { builtInRoles, type RoleStanding, type TeamRole } from "./roles";

/** One role as its file holds it — `roles/<id>.json`. The id lives in the
 * file's NAME, so a record cannot disagree with its own address. */
export interface StoredRole {
  label: string;
  summary: string;
  /** One paragraph per entry, told to the holder. */
  charter: string[];
  /** Only a role of the user's OWN may say these — see the module comment.
   * Absent, a custom role is a repeatable working role, the commonest
   * kind. `leads` is not offered: a team's lead stays the built-in one. */
  repeatable?: boolean;
  standing?: Exclude<RoleStanding, "leads">;
}

/**
 * Why `id` cannot name a role of the user's own, or null when it can.
 *
 * The id IS the address teammates type, which is where every rule comes
 * from: it has to be typeable, and it must not end the way a holder's
 * number does — a role called `impl-2` would be indistinguishable from
 * the second holder of `impl` on the wire.
 *
 * Shared by the merge and the settings form, so the form refuses in
 * exactly the words the merge would.
 */
export function roleIdProblem(id: string): string | null {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    return "a role id is typed as an address: lowercase letters, digits and dashes, starting with a letter";
  }
  if (id.length > 24) {
    return "a role id longer than 24 characters is not an address anyone types";
  }
  if (/-\d+$/.test(id)) {
    return "a role id cannot end in a dash and digits — that tail is how holders are numbered (impl-2 is the second impl)";
  }
  return null;
}

/**
 * Why these role TEXTS cannot brief anyone, or null when they can — the
 * demands `readStoredRole` makes of a file, exported so the settings form
 * asks them BEFORE writing one and refuses in exactly the same words.
 */
export function roleTextsProblem(record: StoredRole): string | null {
  if (!record.label.trim()) return "label is missing or empty";
  if (!record.summary.trim()) return "summary is missing or empty";
  if (record.charter.length === 0 || record.charter.some((line) => !line.trim())) {
    return "charter must be a non-empty list of non-empty lines";
  }
  return null;
}

type ReadStored =
  | { ok: true; role: StoredRole }
  | { ok: false; problem: string };

/** What one stored record means, field by field — or why it means nothing.
 * Reads `unknown` because the bytes come from a hand-editable file, and a
 * shape the type system promised is exactly what such a file cannot. The
 * SHAPE questions live here; the text questions are [`roleTextsProblem`]'s,
 * shared with the form. */
function readStoredRole(raw: unknown): ReadStored {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, problem: "the record is not an object" };
  }
  const record = raw as Record<string, unknown>;
  if (record.repeatable !== undefined && typeof record.repeatable !== "boolean") {
    return { ok: false, problem: "repeatable must be true or false" };
  }
  const standing = record.standing;
  if (standing !== undefined && standing !== "reports" && standing !== "peer") {
    return {
      ok: false,
      problem: 'standing can be "reports" or "peer" — a team\'s lead stays the built-in one',
    };
  }
  // A wrong-typed text lands as an empty one and is refused by the shared
  // predicate — "missing" and "not text" call for the same fix.
  const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  const charterRaw = record.charter;
  const role: StoredRole = {
    label: text(record.label),
    summary: text(record.summary),
    charter: Array.isArray(charterRaw) ? charterRaw.map(text) : [],
    repeatable: record.repeatable as boolean | undefined,
    standing,
  };
  const problem = roleTextsProblem(role);
  return problem ? { ok: false, problem } : { ok: true, role };
}

/**
 * The whole catalog: built-ins, edited where a record names them, then the
 * user's own roles — with every refusal NAMED, because the person who can
 * fix a bad record is the one reading `problems`.
 *
 * Records arrive as `unknown` keyed by the id their file carries; this is
 * the one door user bytes enter the catalog through, so all validation
 * lives behind it. Custom roles come out sorted by id: the file system
 * gave them no order worth preserving, and a stable one keeps the dialog's
 * picker from reshuffling between sessions.
 */
export function mergeRoleCatalog(stored: ReadonlyMap<string, unknown>): {
  roles: readonly TeamRole[];
  problems: string[];
} {
  const problems: string[] = [];
  const records = new Map<string, unknown>();
  for (const [rawId, value] of stored) {
    const id = rawId.trim().toLowerCase();
    // Addressing compares lowercased strings, so two spellings of one id
    // would be one address with two contenders for its texts.
    if (records.has(id)) {
      problems.push(
        `${rawId}: two records name this role in different spellings — keeping the first`,
      );
      continue;
    }
    records.set(id, value);
  }

  const roles: TeamRole[] = [];
  for (const base of builtInRoles()) {
    const record = records.get(base.id);
    records.delete(base.id);
    if (record === undefined) {
      roles.push(base);
      continue;
    }
    const read = readStoredRole(record);
    if (!read.ok) {
      problems.push(`${base.id}: ${read.problem} — using the built-in texts`);
      roles.push(base);
      continue;
    }
    // Texts land; semantics do not. Only a hand edit can put these fields
    // on a built-in's record — the form never offers them — so the note
    // tells that person what happened rather than silently shrugging.
    if (read.role.repeatable !== undefined || read.role.standing !== undefined) {
      problems.push(
        `${base.id}: repeatable and standing are the deck's to decide for a built-in role — texts applied, the rest ignored`,
      );
    }
    roles.push({
      ...base,
      label: read.role.label,
      summary: read.role.summary,
      charter: read.role.charter,
    });
  }

  for (const id of [...records.keys()].sort()) {
    const idProblem = roleIdProblem(id);
    if (idProblem) {
      problems.push(`${id}: ${idProblem}`);
      continue;
    }
    const read = readStoredRole(records.get(id));
    if (!read.ok) {
      problems.push(`${id}: ${read.problem}`);
      continue;
    }
    roles.push({
      id,
      label: read.role.label,
      summary: read.role.summary,
      charter: read.role.charter,
      repeatable: read.role.repeatable ?? true,
      standing: read.role.standing ?? "reports",
    });
  }
  return { roles, problems };
}
