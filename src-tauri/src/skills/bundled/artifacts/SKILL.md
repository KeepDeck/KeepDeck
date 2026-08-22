---
name: artifacts
description: "Publish a visual presentation page (HTML/Markdown artifact) that opens in the user's browser and refreshes live while you iterate — for when the user asks to show/diagram something or a design is being worked through together; the terminal stays the default output channel."
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

## Publishing

Call artifact_publish with a `path` to the file you wrote (preferred — the file must live INSIDE your pane's cwd, and its extension must match the declared format) or inline `content`. Give it a short lowercase `id` (dashes, e.g. `auth-flow`) — teammates reference artifacts by id in mail. `format` is `html` or `md` and is PINNED at first publish: a flip is refused; publish a new artifact instead.

The result carries TWO urls — the artifact's and the workspace index. PRINT BOTH, verbatim, so the user's scrollback is a recovery surface.

The FIRST publish of a new artifact opens in the user's browser automatically (they can turn that off). Later versions NEVER re-open a tab: the open page refreshes by itself. To make that work, include this block UNCHANGED near the end of the page's `<body>` (for html artifacts):

```html
<script>
(()=>{const note=()=>{const n=document.createElement("div");
n.setAttribute("style","background:#fff;color:#000;padding:8px;position:fixed;bottom:0;left:0;right:0;z-index:9999");
n.textContent="This page's server went away — republish or reopen from the agent's message.";
document.body.appendChild(n);};
const es=new EventSource(location.pathname+"/events"+location.search);
es.addEventListener("version",()=>location.reload());
es.addEventListener("bye",()=>{es.close();note();});
es.addEventListener("error",()=>{es.close();note();});})();
</script>
```

That is the whole live-refresh contract: reload on `version`, say goodbye on `bye` or `error`. Do NOT modify it into a reconnect or add your own version events — the loop guard is that the server never sends unsolicited version events, and reconnect-with-replay logic on the page side would break that contract. (`md` artifacts need nothing — the server renders them WITH this same block injected, so they refresh exactly like html pages.)

## Working as a team

Artifacts are shared objects, like mail is messages:

- Publish, then send a mail note NAMING the id ("published `auth-flow`, please review").
- Teammates read with artifact_read (inline content) and answer in mail; iterate by REPUBLISHING the same id — everyone's open tab updates.
- artifact_list shows the workspace's artifacts.

## Deleting

artifact_delete removes an artifact entirely. ONLY on explicit instruction from the user or a teammate's request — NEVER as self-directed cleanup of something that looks stale. Deleting is idempotent and logged; when in doubt, ask in mail first.
