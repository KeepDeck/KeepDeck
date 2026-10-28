/**
 * The stored frontmatter shapes five review rounds turned up, in one place.
 *
 * Each of these once broke a hand-rolled reader or a re-composed write. They were
 * copied between two domain suites and the library's — the indented mapping five
 * times, the block-scalar description four — so the SIXTH shape would be added to
 * whichever file its finder happened to open, and the other suites would never
 * see it. Named here so a new shape reaches every assertion that cares.
 *
 * Verbatim byte literals stay local to the case that is ABOUT those bytes; what
 * belongs here is the input, not the expectation.
 */

/** Shapes that are valid YAML and must survive being opened and saved. */
export const CARRIED: Record<string, string> = {
  plain: "---\nname: review\ndescription: Reviews a diff\nlicense: MIT\n---\nBody\n",
  foldedDescription:
    "---\nname: review\ndescription: >\n  Long one,\n  wrapped.\nlicense: MIT\n---\nBody\n",
  blockHeaderWithComment:
    "---\nlicense: MIT\nname: demo\ndescription: >- # short\n  one\n  two\n---\nBody\n",
  indicatorBeforeChomping: "---\nname: demo\ndescription: >2-\n  one\n  two\n---\nBody\n",
  literalDescription: "---\nname: demo\ndescription: |\n  step one\n  step two\n---\nBody\n",
  blockScalarName: "---\nname: >\n  old-skill\ndescription: Reviews\n---\nBody\n",
  quotedMultiLine: '---\nlicense: MIT\nname: a\ndescription: "one\n  two"\n---\nbody\n',
  plainMultiLine: "---\nlicense: MIT\nname: a\ndescription: one\n  two\n---\nbody\n",
  quotedKey: '---\n"name": review\ndescription: d\n---\nBody\n',
  spacedKey: "---\nname : review\ndescription: d\n---\nBody\n",
  trailingCommentOnValue: "---\nname: demo\ndescription: Reviews a diff # keep short\n---\nB\n",
  escapeInValue: '---\nname: demo\ndescription: "caf\\u00e9 au lait"\n---\nB\n',
  trailingCommentOnName: "---\nname: old # the id\ndescription: d\n---\nbody\n",
  indentedComment: "---\nname: demo\ndescription: d\n  # a note\n---\nBody\n",
  extraKeyBlockScalar: "---\nname: n\ndescription: d\nallowed-tools: >\n  Read\n  Write\n---\nB\n",
  paddedFence: "---\nname: demo\ndescription: Reviews\n---  \nBody\n",
  standaloneComment:
    "---\nname: demo\ndescription: d\n# why this is pinned\nallowed-tools: Read\n---\nBody\n",
  commentBeforeFence: "---\nname: demo\ndescription: d\n# last word\n---\nBody\n",
  crlf: "---\r\nname: demo\r\ndescription: Reviews\r\n---\r\nBody\r\n",
  bom: "﻿---\nname: demo\ndescription: Reviews\n---\nBody\n",
  // An anchor shared only among keys we CARRY: re-emitted verbatim with them, so
  // refusing it was a false refusal.
  anchorAmongExtras: "---\nname: a\ndescription: d\nbase: &b 1\nalso: *b\n---\nBody\n",
  // Trailing blank lines a keep-chomped block counts as its value.
  keptBlankLines: "---\nname: a\ndescription: d\nnotes: |+\n  x\n\n\n---\nbody\n",
  commentAboveOurKey: "---\n# top note\nname: a\ndescription: b\n---\nbody\n",
};

/** Shapes a real reader accepts and our composer would change the meaning of, so
 * authoring over them is REFUSED rather than attempted. The value is the phrase
 * the refusal must name. */
export const REFUSED: Record<string, { content: string; because: string }> = {
  indentedMapping: {
    content: "---\n  name: old-skill\n  description: d\n---\nBody\n",
    because: "indented",
  },
  notAMapping: { content: "---\n- just\n- a list\n---\nB\n", because: "not a list of keys" },
  invalidYaml: { content: "---\nname: [unclosed\n---\nB\n", because: "not valid YAML" },
  sharedAnchor: {
    content: "---\nname: &n review\ndescription: Reviews\ntitle: *n\n---\nBody\n",
    because: "shares a value",
  },
  taggedMapping: {
    content: "---\n!mytag\nname: a\ndescription: d\n---\nBody\n",
    because: "is tagged",
  },
  duplicatedKey: {
    content: "---\nname: demo\ndescription: first\ndescription: second\n---\nBody\n",
    because: "more than once",
  },
  nonScalarKey: {
    content: "---\nname: demo\ndescription: d\n[a, b]: kept by a reader\n---\nBody\n",
    because: "not a plain name",
  },
};
