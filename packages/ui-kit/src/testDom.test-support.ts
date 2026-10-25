/** The ui-kit's own DOM guards: a found node is proven before a test reads or
 * clicks it, so a missing one fails by name instead of a null dereference. */
export function instanceOf<T>(
  value: unknown,
  ctor: abstract new (...args: never[]) => T,
  what: string,
): T {
  if (!(value instanceof ctor)) throw new Error(`expected ${what} to be a ${ctor.name}`);
  return value;
}

export function elementOf<T extends Element>(
  root: ParentNode,
  selector: string,
  ctor: abstract new (...args: never[]) => T,
): T {
  return instanceOf(root.querySelector(selector), ctor, selector);
}
