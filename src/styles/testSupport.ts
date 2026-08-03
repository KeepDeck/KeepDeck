import { readFileSync } from "node:fs";
import { join } from "node:path";

export const STYLES_DIR = "src/styles";

/**
 * The app's real stylesheet, assembled the way the app assembles it: every
 * sheet `index.css` imports, in import order, so a style test mounts what
 * ships rather than the one file it happens to be about. Source order is the
 * whole point — the cascade's tie-breaker is what several of these tests are
 * actually asserting.
 *
 * Shared because three test files needed it and a fourth would have copied
 * the import walk again; each caller still owns its own transform (happy-dom
 * drops some values and has to be handed them as custom properties) and its
 * own fixture.
 */
export const appCss = [
  ...readFileSync(join(STYLES_DIR, "index.css"), "utf8").matchAll(
    /@import\s+"([^"]+)"\s*;/g,
  ),
]
  .map((match) =>
    readFileSync(join(STYLES_DIR, match[1].replace(/^\.\//, "")), "utf8"),
  )
  .join("\n");
