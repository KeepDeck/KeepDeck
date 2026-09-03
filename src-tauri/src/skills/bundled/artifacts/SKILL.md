---
name: artifacts
description: "Publish a visual presentation page (an html artifact) that opens in the user's browser and refreshes live while you iterate — for when the user asks to show/diagram something or a design is being worked through together; the terminal stays the default output channel."
---
# Artifacts — visual presentation pages for your teammates and user

## When to reach for this

- The user asks to SHOW, diagram, or visualize something ("show me the flow", "what will it look like").
- You are working through a DESIGN with others (a feature's screens, an architecture, a block scheme, a comparison table) and terminal ASCII is the wrong medium.
- A teammate asks you to present or review work as a shareable page.

The terminal stays the DEFAULT output channel. An artifact is for when a page is genuinely the better form — not a wrapper around ordinary output.

## How to build the page

One self-contained file. It renders under a strict Content-Security-Policy on a localhost server:

- ALL CSS and JavaScript INLINE. No external scripts, styles, fonts, or images — external fetches are blocked. Embed images as data URIs.
- Real data over placeholders: use the actual numbers, names, and code you are presenting.
- Diagrams: inline SVG, or a hand-rolled HTML/CSS diagram. No CDN libraries (they cannot load).
- Keep it readable in a browser tab: system fonts, clear hierarchy, no framework boilerplate.
- ONE visual style for the whole document. Pick whatever fits the content, but
  every section — headers, cards, tables, diagrams, code blocks — follows the
  SAME palette, spacing and typography; a page that switches style halfway
  reads as two documents stapled together. Prefer a dark theme (a light
  `pre`/code block on a dark page is fine; a light SECTION is not).

## Publishing

Call artifact_publish with a `path` to the file you wrote (preferred — the file must live INSIDE your pane's cwd, and the file must be `.html`) or inline `content`. `title` is required — it is what the workspace index and `artifact_list` show, and nothing injects it into the page, so give the page its own heading too. Give it a short lowercase `id` (dashes, e.g. `auth-flow`) — teammates reference artifacts by id in mail, and omitting it mints one from the title. `format` is `html` — an artifact IS an html page, and anything else is refused at the door.

Scripted callers (running a tool call from a script, not typing it): prefer
`path` over `content` — a value computed in the script (a read piped into a
variable) may arrive as undefined unless it is materialized in a real file
first. If a publish is refused with "needs one of `path` or `content`", the
content never made it into the call: write the bytes to a file in your cwd and
publish the path.

The result carries TWO urls — the artifact's and the workspace index. PRINT BOTH, verbatim. They are SESSION-SCOPED: the port is fresh on every KeepDeck launch, so a url in scrollback works until KeepDeck restarts. What is durable is the ID — say it too, always.

**Never republish just to hand out a working url.** A version is a change to the artifact, and one published because an address expired says the page changed when nothing did. The user reopens an artifact from KeepDeck, under Artifacts, which resolves a live url at the moment they click; you give them the id.

The FIRST publish of a new artifact opens in the user's browser automatically (they can turn that off). Later versions NEVER re-open a tab: the open page refreshes by itself.

**Write no refresh script.** The server installs one on every page it serves — nothing for you to include, and nothing to copy from anywhere. Do not write your own `EventSource`, polling loop, or reload timer: the server cuts an authored one before installing its own, so yours is deleted rather than run.

## Working as a team

Artifacts are shared objects, like mail is messages:

- Publish, then send a mail note NAMING the id ("published `auth-flow`, please review").
- Teammates read with artifact_read (inline content) and answer in mail; iterate by REPUBLISHING the same id — everyone's open tab updates.
- artifact_list shows the workspace's artifacts.

## Deleting

artifact_delete removes an artifact entirely. ONLY on explicit instruction from the user or a teammate's request — NEVER as self-directed cleanup of something that looks stale. Deleting is idempotent and logged; when in doubt, ask in mail first.
