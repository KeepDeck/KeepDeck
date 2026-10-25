import "react";

/**
 * A style may set a CSS custom property — `--series`, `--progress-ring-fill` —
 * which React passes through as written. React's own CSSProperties names only
 * the standard properties, so without this every such style was asserted
 * into shape.
 */
declare module "react" {
  interface CSSProperties {
    [property: `--${string}`]: string | number | undefined;
  }
}
