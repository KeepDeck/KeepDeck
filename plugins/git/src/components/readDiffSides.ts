import type { GitPorts } from "../runtime";
import { sideText, type DiffSides, type SideRead } from "../domain/diffRead";

/** Both sides' whole texts, null where a side is not to be had. */
export interface SideTexts {
  old: string | null;
  new: string | null;
}

/**
 * Execute `diffSidesFor`'s reads: the stored file through git, the working
 * one through fs, together. A side that fails to read is a side without
 * text, not a failed diff — the hunks are already on screen, and the
 * highlighter colors each one from itself instead. A deleted working file is
 * the everyday case of that.
 */
export async function readDiffSides(
  services: GitPorts["services"],
  repo: string,
  sides: DiffSides,
): Promise<SideTexts> {
  const read = async (side: SideRead | null): Promise<string | null> => {
    if (!side) return null;
    try {
      return sideText(
        side.source === "git"
          ? await services.git.fileAt(repo, side.path, side.rev)
          : await services.fs.readFile(side.path),
      );
    } catch {
      return null;
    }
  };
  const [before, after] = await Promise.all([read(sides.old), read(sides.new)]);
  return { old: before, new: after };
}
