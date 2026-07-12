import type { CSSProperties } from "react";
import type { LineTokens, Token } from "./tokens";

/**
 * One line's colored runs, as inline-styled spans — the theme's colors ride
 * the tokens (Shiki resolves them at tokenize time), so there is no CSS class
 * vocabulary to ship or keep in sync. Drop-in for the plain `{line || " "}`
 * idiom: an empty line renders the same height-preserving space, and a token
 * with no style at all renders as a bare span the consumer's own text color
 * shows through.
 */
export function TokenLine({ tokens }: { tokens: LineTokens }) {
  // A space keeps an empty line's row height under white-space: pre — the
  // same trick the plain path uses.
  if (tokens.length === 0) return <>{" "}</>;
  return (
    <>
      {tokens.map((token, index) => (
        // Runs are positional within one immutable line — index is stable.
        <span key={index} style={styleFor(token)}>
          {token.text}
        </span>
      ))}
    </>
  );
}

function styleFor(token: Token): CSSProperties | undefined {
  if (!token.color && !token.italic) return undefined;
  const style: CSSProperties = {};
  if (token.color) style.color = token.color;
  if (token.italic) style.fontStyle = "italic";
  return style;
}
