/**
 * Path → Shiki language id. Pure string work, no engine: the id this returns
 * must be one the kit's highlighter actually loaded (see highlighter.ts —
 * `tokenizeLines` re-checks and returns null otherwise), so an id here that
 * drifts from the grammar set degrades to plain text, never to a crash.
 *
 * `null` means "no known language" — the viewer renders plain. Matching is
 * case-insensitive on the basename (README.MD is markdown).
 */

/** Extension (no dot) → language id. Deliberately opinionated on ambiguity:
 * `.h` is C (the common case; C++ headers usually pick .hpp/.hh), `.m` is
 * Objective-C (over MATLAB — this is a coding-agent cockpit). */
const BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  rs: "rust",
  toml: "toml",
  yml: "yaml",
  yaml: "yaml",
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  py: "python",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  sql: "sql",
  xml: "xml",
  svg: "xml",
  plist: "xml",
  diff: "diff",
  patch: "diff",
  ini: "ini",
  cfg: "ini",
  graphql: "graphql",
  gql: "graphql",
  lua: "lua",
  vue: "vue",
  svelte: "svelte",
  m: "objective-c",
  mm: "objective-c",
  pl: "perl",
  pm: "perl",
};

/** Whole basenames that carry a language without an extension. Shell rc files
 * are here because their "extension" (`.zshrc` → "zshrc") is really a name. */
const BY_BASENAME: Record<string, string> = {
  dockerfile: "docker",
  makefile: "make",
  gnumakefile: "make",
  ".bashrc": "shellscript",
  ".bash_profile": "shellscript",
  ".zshrc": "shellscript",
  ".zprofile": "shellscript",
  ".zshenv": "shellscript",
};

/** The Shiki language id for `path`, or null for "render plain". */
export function langFor(path: string): string | null {
  const base = tail(path).toLowerCase();
  const byName = BY_BASENAME[base];
  if (byName) return byName;
  // Dockerfile.dev, Dockerfile.prod … — the suffix is a flavor, not a lang.
  if (base.startsWith("dockerfile.")) return "docker";
  const dot = base.lastIndexOf(".");
  // No dot, or a leading dot only (an unlisted dotfile like `.gitignore` has
  // no extension — its whole name IS the "extension" split would produce).
  if (dot <= 0) return null;
  return BY_EXTENSION[base.slice(dot + 1)] ?? null;
}

/** Last path segment; tolerates both separators and a trailing slash. */
function tail(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return at >= 0 ? trimmed.slice(at + 1) : trimmed;
}
