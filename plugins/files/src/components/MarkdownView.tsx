import { Fragment } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { TokenLine, useHighlight } from "@keepdeck/code-kit";
import { getRuntime } from "../runtime";

/**
 * Rendered Markdown for the file preview. react-markdown compiles to React
 * elements — raw HTML in the source is IGNORED by default (no rehype-raw
 * here, deliberately): a README from a just-cloned repo is untrusted input,
 * and this renders inside the privileged app webview. GFM (tables, task
 * lists, strikethrough, autolinks) via remark-gfm.
 *
 * Two element overrides, both for the same reason — the document is not a
 * browser page:
 * - links must not navigate the app's webview away; http(s) goes to the
 *   default browser through the opener capability, anything else is inert;
 * - fenced code is colored by code-kit (the fence's language name is passed
 *   straight through — Shiki's alias table knows "bash" and "ts"), inside
 *   the `<pre><code>` react-markdown already made.
 */
export function MarkdownView({ text }: { text: string }) {
  return (
    <div className="files__md">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  );
}

const components: Components = {
  a({ href, children, node: _node, ...rest }) {
    const external = typeof href === "string" && /^https?:\/\//i.test(href);
    return (
      <a
        {...rest}
        href={href}
        onClick={(event) => {
          // A naive click would navigate the WHOLE app (the webview hosts
          // the deck, not this document). External links open in the user's
          // browser; relative paths and anchors have no document to resolve
          // against here, so they stay inert rather than half-work.
          event.preventDefault();
          if (external) void getRuntime().services.opener.openUrl(href);
        }}
      >
        {children}
      </a>
    );
  },
  code({ className, children, node: _node, ...rest }) {
    const fence = /language-([\w+#.-]+)/.exec(className ?? "")?.[1];
    // No language- class = inline code or a bare ``` fence — as-is.
    if (!fence || typeof children !== "string") {
      return (
        <code className={className} {...rest}>
          {children}
        </code>
      );
    }
    return (
      <code className={className} {...rest}>
        {/* The fence's text ends with the closing fence's newline; rendering
            it would show a phantom empty line inside the block. */}
        <FencedCode code={children.replace(/\n$/, "")} lang={fence} />
      </code>
    );
  },
};

/** One fenced block's colored lines — progressive like the code view: plain
 * text at once, color when tokens land; an unknown fence name stays plain. */
function FencedCode({ code, lang }: { code: string; lang: string }) {
  const tokens = useHighlight(code, lang);
  if (!tokens) return <>{code}</>;
  return (
    <>
      {tokens.map((line, index) => (
        // Lines are positional within one immutable block — index is stable.
        <Fragment key={index}>
          {index > 0 ? "\n" : null}
          <TokenLine tokens={line} />
        </Fragment>
      ))}
    </>
  );
}
