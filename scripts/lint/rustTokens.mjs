/**
 * The words a Rust source DECIDES with: identifiers and string literals,
 * each with its line. Comments (line, block — nested — and doc) and char
 * literals are skipped, and so is every item under `#[cfg(test)]`: the
 * attribute's item runs to its `;` or its closing brace. Enough Rust to
 * read the repo's own sources for scripts/coreCliNames.test.mjs, not a
 * parser.
 * @param {string} source
 * @returns {{ text: string, line: number }[]}
 */
export function rustWords(source) {
  return dropTestItems(lex(source)).filter((token) => token.kind !== "punct");
}

/** Each pattern is tried at the current position, in this order. */
const RAW_STRING = /b?r(#*)"/y;
const STRING = /b?"((?:[^"\\]|\\[\s\S])*)"/y;
const CHAR = /b?'(?:\\u\{[0-9a-fA-F]+\}|\\.|[^\\'])'/uy;
const LIFETIME = /'[A-Za-z_][A-Za-z0-9_]*/y;
const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;
const NUMBER = /[0-9][0-9A-Za-z_]*/y;

/** @param {RegExp} pattern @param {string} source @param {number} at */
function match(pattern, source, at) {
  pattern.lastIndex = at;
  return pattern.exec(source);
}

/** @param {string} source */
function lex(source) {
  /** @type {{ kind: "ident" | "string" | "punct", text: string, line: number }[]} */
  const tokens = [];
  let i = 0;
  let line = 1;
  const advance = (to) => {
    for (; i < to; i += 1) if (source[i] === "\n") line += 1;
  };
  while (i < source.length) {
    let found;
    if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i);
      advance(end === -1 ? source.length : end);
    } else if (source.startsWith("/*", i)) {
      let depth = 0;
      let j = i;
      do {
        if (source.startsWith("/*", j)) (depth += 1), (j += 2);
        else if (source.startsWith("*/", j)) (depth -= 1), (j += 2);
        else j += 1;
      } while (depth > 0 && j < source.length);
      advance(j);
    } else if ((found = match(RAW_STRING, source, i))) {
      const start = i + found[0].length;
      const close = `"${found[1]}`;
      const end = source.indexOf(close, start);
      const stop = end === -1 ? source.length : end;
      tokens.push({ kind: "string", text: source.slice(start, stop), line });
      advance(stop + close.length);
    } else if ((found = match(STRING, source, i))) {
      tokens.push({ kind: "string", text: found[1], line });
      advance(i + found[0].length);
    } else if ((found = match(CHAR, source, i) ?? match(LIFETIME, source, i) ?? match(NUMBER, source, i))) {
      advance(i + found[0].length);
    } else if ((found = match(IDENT, source, i))) {
      tokens.push({ kind: "ident", text: found[0], line });
      advance(i + found[0].length);
    } else {
      if (!/\s/.test(source[i])) tokens.push({ kind: "punct", text: source[i], line });
      advance(i + 1);
    }
  }
  return tokens;
}

const CFG_TEST = ["#", "[", "cfg", "(", "test", ")", "]"];

/** Drop each item `#[cfg(test)]` marks: its further attributes, then up to
 * its `;` or the end of its first top-level brace block.
 * @param {ReturnType<typeof lex>} tokens */
function dropTestItems(tokens) {
  const kept = [];
  let i = 0;
  while (i < tokens.length) {
    if (!CFG_TEST.every((text, k) => tokens[i + k]?.text === text)) {
      kept.push(tokens[i]);
      i += 1;
      continue;
    }
    i += CFG_TEST.length;
    let depth = 0;
    for (; i < tokens.length; i += 1) {
      const text = tokens[i].kind === "punct" ? tokens[i].text : "";
      if (text === "(" || text === "[" || text === "{") depth += 1;
      else if (text === ")" || text === "]") depth -= 1;
      else if (text === "}") {
        depth -= 1;
        if (depth === 0) break;
      } else if (text === ";" && depth === 0) break;
    }
    i += 1;
  }
  return kept;
}
