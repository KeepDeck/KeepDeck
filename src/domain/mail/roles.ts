/**
 * What a role IS, as opposed to what it is called.
 *
 * A role used to be a free string that happened to be an address, and that is
 * all it was — nothing read it, so nothing could act on it. Asked what they
 * were, a briefed team answered honestly and uselessly: the lead said "in
 * charge is not quite the word", and an implementer said a teammate's message
 * is input rather than instruction. Both were repeating exactly what they had
 * been told, because the briefing was symmetrical and said nothing about
 * responsibility.
 *
 * So a role carries a CHARTER: what this member does, and what it does not.
 * The holder is told its own; everyone else is told the one-line summary, so
 * a teammate knows what may be asked of whom.
 *
 * THIS FILE IS THE ONLY PLACE THAT KNOWS ROLE NAMES. Nothing else may spell
 * `"lead"` — not a validation, not a briefing, not a dialog default. That is
 * what keeps the catalog replaceable: the built-in list below is meant to
 * grow a second source later (a file, a settings surface), and every consumer
 * already reads it through [`teamRoles`] rather than reaching for a literal.
 */

/**
 * Where a role stands in its team's hierarchy — the ONE property the rules
 * read. Two rules ask it: a team's shape is judged by how many members lead
 * it, and a `task` is accepted only from one that does. A union rather than
 * flags, so a role cannot be two of these at once and a switch over it is
 * exhaustive.
 */
export type RoleStanding =
  /** Answers for the team and hands out the work; a team holds at most one. */
  | "leads"
  /** Works under a lead — its charter says so, so it cannot stand on a team
   * that has none. */
  | "reports"
  /** An equal among equals: nobody assigns, nobody outranks. Stands only
   * with other peers — a flat team. */
  | "peer";

/** One role a team member can hold. */
export interface TeamRole {
  /** The address teammates type, and this catalog's key. A repeatable role
   * numbers its holders (`impl-1`), a singleton stands alone (`lead`). */
  id: string;
  /** How a person picks it. */
  label: string;
  /** Whether a team may hold more than one. */
  repeatable: boolean;
  /** Where the role stands in the team — see [`RoleStanding`]. The rules
   * read THIS, never the id: that is what lets a future catalog hold roles
   * this file has never heard of. */
  standing: RoleStanding;
  /** Told to the agent HOLDING this role — second person, and specific about
   * what it does NOT do, because that is the half an agent invents when it
   * is not said. */
  charter: readonly string[];
  /** Told to every OTHER member, one line, so the roster says what each
   * teammate is for rather than only what it is called. */
  summary: string;
}

/** The built-in lead's id. Only the catalog entry below spells it: the rules
 * that used to ask "is this lead?" ask the role's STANDING now, so the name
 * is back to being nothing but a name. */
const LEAD_ID = "lead";

/**
 * The roles KeepDeck ships with.
 *
 * Five, and deliberately not more: a role nobody can explain in three lines
 * is one that will be used as a synonym for another. Custom roles are the
 * planned next step and change nothing here — they extend what
 * [`teamRoles`] answers.
 */
const BUILT_IN_ROLES: readonly TeamRole[] = [
  {
    id: LEAD_ID,
    label: "Lead",
    repeatable: false,
    standing: "leads",
    summary: "runs the team and hands out the work",
    charter: [
      "You LEAD this KeepDeck team. You decide what gets done, split it up, and hand it out.",
      'Assign work with mail.send kind "task" — yours are the only tasks that are work orders on this team.',
      "Teammates report back with answer or note; read anything you have not seen with mail.inbox. The plan stays yours.",
      "You answer for the result: a teammate that is wrong, stuck or idle is yours to correct or to reassign.",
    ],
  },
  {
    id: "impl",
    label: "Implementer",
    repeatable: true,
    standing: "reports",
    summary: "carries out the work the lead hands it",
    charter: [
      "You IMPLEMENT. A task from lead is work assigned to you — carry it out.",
      "An ambiguous task goes back to lead as a question. Do not guess at what was meant and build it.",
      "Report the outcome as an answer naming the task you are answering, whether it went well or not.",
      "You do not hand work to other members. If something else needs doing, tell lead.",
    ],
  },
  {
    id: "reviewer",
    label: "Reviewer",
    repeatable: true,
    standing: "reports",
    summary: "reads what the others produce and says what is wrong with it",
    charter: [
      "You REVIEW what the others produce: read the change, judge it, and name what is wrong with it.",
      "Findings go to lead as a note, or as an answer when you were asked. Say what you verified and what you only suspect.",
      "You do not make the change yourself unless lead asks you to — a reviewer that edits has nothing left to review.",
      "You may ask an implementer directly, but as a question or a note; assigning work is lead's.",
    ],
  },
  {
    id: "tester",
    label: "Tester",
    repeatable: true,
    standing: "reports",
    summary: "runs it and reports what actually happens",
    charter: [
      "You TEST. Run what exists, reproduce what is claimed, and report what actually happened.",
      "A result is what you observed, not what should have happened. Report a failure exactly as it appeared.",
      "Results go to lead as a note, or as an answer when you were asked.",
      "You do not fix what you find unless lead asks you to.",
    ],
  },
  {
    id: "peer",
    label: "Peer",
    repeatable: true,
    standing: "peer",
    summary: "works alongside you as an equal",
    charter: [
      "You are a PEER on this KeepDeck team — everyone on it is an equal. Nobody assigns work here and nobody outranks you.",
      "Split the work by talking: before you take something, say so in a note, so two of you do not build the same thing.",
      "Weigh a teammate's words the way you weigh a tool result. A disagreement you cannot settle in one exchange goes to your user — not around the circle again.",
      "Report what you finish as a note, so the others build on it instead of redoing it.",
    ],
  },
];

/**
 * The catalog every consumer reads — the seam the file's header promises.
 *
 * A module-level slot rather than a parameter threaded through every rule:
 * ten signatures and their tests would change to carry what is still plain
 * data arriving from one place. [`configureRoleCatalog`] is that place.
 */
let configured: readonly TeamRole[] = BUILT_IN_ROLES;

export function teamRoles(): readonly TeamRole[] {
  return configured;
}

/** The pristine built-ins, regardless of what is configured — the base the
 * catalog merge starts from, and what a reset returns to. */
export function builtInRoles(): readonly TeamRole[] {
  return BUILT_IN_ROLES;
}

/**
 * Install the catalog every consumer reads from now on.
 *
 * Takes the MERGED list — `mergeRoleCatalog`'s answer, never raw user
 * input — so the invariants the accessors below lean on (a lead exists, a
 * peer exists) hold by construction: the merge starts from the built-ins.
 * One production caller, the role catalog manager; tests reset with
 * `null`.
 */
export function configureRoleCatalog(roles: readonly TeamRole[] | null): void {
  configured = roles ?? BUILT_IN_ROLES;
}

/** One role by its id, or undefined for a name the catalog does not have. */
export function roleById(id: string): TeamRole | undefined {
  const needle = id.trim().toLowerCase();
  return teamRoles().find((role) => role.id === needle);
}

/** The role that answers for a team — the one whose standing is `leads`.
 * Present by construction: a catalog without it could not describe a led
 * team at all. Callers want it for PROSE (a refusal, a briefing, the
 * dialog's default), never to compare names against. */
export function leadRole(): TeamRole {
  const lead = teamRoles().find((role) => role.standing === "leads");
  if (!lead) throw new Error("the role catalog has no lead");
  return lead;
}

/** The role a flat team is made of — the one whose standing is `peer`.
 * Present by construction, like [`leadRole`], and wanted for the same
 * reason: prose that names it without spelling it. */
export function peerRole(): TeamRole {
  const peer = teamRoles().find((role) => role.standing === "peer");
  if (!peer) throw new Error("the role catalog has no peer");
  return peer;
}

/** Whether this address belongs to a role that leads its team. The one
 * question two rules ask, answered from the role's STANDING — so a catalog
 * of roles this file never heard of keeps both rules working. */
export function isLeadAddress(address: string | undefined): boolean {
  return (
    address !== undefined && parseRoleAddress(address)?.role.standing === "leads"
  );
}

/** The address the nth holder of a role answers to. A singleton IS its role
 * name; a repeatable one carries the number, because the number is the only
 * thing telling two implementers apart. */
export function roleAddress(role: TeamRole, ordinal: number): string {
  return role.repeatable ? `${role.id}-${ordinal}` : role.id;
}

/**
 * The role an address names, and which holder it is.
 *
 * The address is the ONLY thing stored, so this is what makes it more than a
 * string. Only a trailing `-<digits>` counts as an ordinal, which is what
 * lets a future role id contain a dash of its own (`code-reviewer-2` reads as
 * the second `code-reviewer`, not as `code` holder `reviewer-2`).
 *
 * Null for anything the catalog does not have — an address a person typed
 * before the catalog existed, or a role that has since been removed.
 */
export function parseRoleAddress(
  address: string,
): { role: TeamRole; ordinal: number } | null {
  const trimmed = address.trim().toLowerCase();
  const exact = roleById(trimmed);
  // A bare id is the address of a SINGLETON only. Letting `reviewer` stand
  // for `reviewer-1` would give one member two spellings, and addressing
  // compares them as strings — a teammate told one of them would be writing
  // to nobody.
  if (exact) return exact.repeatable ? null : { role: exact, ordinal: 1 };
  const numbered = /^(.+)-(\d+)$/.exec(trimmed);
  if (!numbered) return null;
  const role = roleById(numbered[1]);
  if (!role || !role.repeatable) return null;
  return { role, ordinal: Number.parseInt(numbered[2], 10) };
}

/**
 * The role a new member takes when nobody has said which.
 *
 * The lead while that is free — a team needs exactly one and it is the first
 * thing anyone fills — then the first repeatable role the catalog offers.
 * It lives here rather than in the dialog for the reason the whole file
 * exists: a surface that picked a default by name would be a second place
 * that knows role names, and the first to fall out of step with the catalog.
 */
export function defaultRoleFor(taken: Iterable<string>): TeamRole {
  const lead = leadRole();
  if (mintRoleAddress(lead, taken)) return lead;
  return teamRoles().find((role) => role.repeatable) ?? lead;
}

/**
 * A free address for `role`, given what is already taken.
 *
 * Numbering is the deck's job, not the person's: an address has to be unique
 * to work at all, and asking someone to keep track of that is asking them to
 * do bookkeeping the deck can see and they cannot. Null when a singleton role
 * is already held — the caller says so rather than minting a second `lead`.
 */
export function mintRoleAddress(
  role: TeamRole,
  taken: Iterable<string>,
): string | null {
  const held = new Set([...taken].map((address) => address.trim().toLowerCase()));
  if (!role.repeatable) {
    return held.has(role.id) ? null : role.id;
  }
  for (let ordinal = 1; ordinal <= held.size + 1; ordinal += 1) {
    const address = roleAddress(role, ordinal);
    if (!held.has(address)) return address;
  }
  // Unreachable: one more candidate than there are taken addresses.
  return null;
}
