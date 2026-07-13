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

/** What a caller passes: primitives only, keys per the command's ArgSpecs. */
export type CommandArgs = Record<string, string | boolean | number>;

/** Validate `args` against `specs`. Returns human-readable problems; empty
 * means valid. Unknown keys are errors, not ignored extras — a misspelled
 * optional argument that silently does nothing is worse than a rejection. */
export function validateArgs(specs: ArgSpec[], args: CommandArgs): string[] {
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
