import type { CommandArgs } from "../../domain/commands";

/**
 * How a core command reads its arguments.
 *
 * Here rather than private to `index.ts` because the area split has started:
 * the first module extracted from it re-answered "how do you read a string
 * argument" with a bare `String(...)`, so one command set began trimming some
 * arguments and not others — `workspace.switch {workspace: "web "}` worked while
 * `skills.create {name: "review "}` was refused. The remaining areas face the
 * same choice, and this is the module they should all reach for.
 *
 * The registry has already validated types and the presence of required
 * arguments before a handler runs (`validateArgs`), so these only normalize.
 *
 * BLANKNESS is deliberately theirs and not the registry's: `""` passes
 * `required` there, and it must, because whether whitespace is a value depends
 * on what the argument IS. A blank identifier is nothing (`requiredStr` refuses
 * it); a blank line of text is something (a lone space sent to a terminal is
 * exactly what the caller meant). One rule at the registry would have to pick
 * one of those and be wrong about the other, so the reader a handler chooses is
 * what says which kind of argument it is reading — and an argument declared
 * required must be read with a required reader, or the declaration is not
 * enforced anywhere.
 */

/** An OPTIONAL string argument: trimmed, and blank counts as absent — a caller
 * that sends `"  "` meant to send nothing. */
export function str(args: CommandArgs, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A REQUIRED string argument, trimmed — for identifiers and short scalars. The
 * registry has already refused a missing or wrong-typed one; a value that is
 * only whitespace reaches here, and refusing it beats passing a blank name down
 * to the backend. */
export function requiredStr(args: CommandArgs, name: string): string {
  const value = str(args, name);
  if (value === undefined) throw new Error(`argument "${name}" must not be blank`);
  return value;
}

/** A required string argument kept VERBATIM — for content, where whitespace is
 * part of the value. A skill's markdown body is the case that makes the
 * distinction necessary: trimming it would silently edit what an agent wrote,
 * and an empty body is legitimate. */
export function text(args: CommandArgs, name: string): string {
  const value = args[name];
  return typeof value === "string" ? value : "";
}
