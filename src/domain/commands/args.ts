/** Command arguments are a FLAT bag of primitives, declared as data. The
 * declarative spec is deliberately minimal: enough to validate a call at the
 * registry and to project a command into an external tool schema (MCP) later
 * — richer shapes would force every transport to grow with them. */
export type ArgType = "string" | "boolean" | "number";

export interface ArgSpec {
  name: string;
  type: ArgType;
  required?: boolean;
  /** Shown to humans in pickers and to external clients as the tool's
   * parameter description — write it for both. */
  description: string;
}

/** What a command runs with: primitives only, keys per its ArgSpecs. */
export type CommandArgs = Record<string, string | boolean | number>;

/** What a caller passes before it is checked: whatever a transport decoded
 * (MCP hands over JSON). The registry checks it against the specs. */
export type RawArgs = Readonly<Record<string, unknown>>;

/** Validate `args` against `specs`. Returns human-readable problems; empty
 * means valid. Unknown keys are errors, not ignored extras — a misspelled
 * optional argument that silently does nothing is worse than a rejection. */
export function validateArgs(specs: ArgSpec[], args: RawArgs): string[] {
  const errors: string[] = [];
  const byName = new Map(specs.map((s) => [s.name, s]));
  for (const key of Object.keys(args)) {
    if (!byName.has(key)) errors.push(`unknown argument "${key}"`);
  }
  for (const spec of specs) {
    const value = args[spec.name];
    if (value === undefined) {
      if (spec.required) errors.push(`missing required argument "${spec.name}"`);
      continue;
    }
    if (typeof value !== spec.type)
      errors.push(`argument "${spec.name}" must be a ${spec.type}`);
  }
  return errors;
}

/** `args` as a command runs with them, once `validateArgs` found nothing:
 * the primitive values, copied — what the check proved, held in a type that
 * says it. */
export function checkedArgs(args: RawArgs): CommandArgs {
  const checked: CommandArgs = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
      checked[key] = value;
    }
  }
  return checked;
}
