/**
 * Format a {command, args} invocation as ONE copy-pasteable POSIX shell
 * line. The whole point of the string is to be pasted into a terminal or a
 * client config, so quoting must silence EVERY shell metacharacter — the
 * round-2 review showed a double-quote strategy leaking `$`, backticks and
 * globs into expansion. Single quotes silence everything except the quote
 * itself, which splices as `'\''`; anything matching the conservative safe
 * set stays bare so the common spaceless path reads clean.
 */
const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function shellLine(invocation: {
  command: string;
  args: string[];
}): string {
  const word = (w: string) =>
    SAFE_WORD.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`;
  return [invocation.command, ...invocation.args].map(word).join(" ");
}
