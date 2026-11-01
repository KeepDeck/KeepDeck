/** The mark refresh.js leaves on a page it has armed, so a second copy of
 * the script on the same page stands down. Typed here rather than in
 * refresh.js, whose bytes are served as they are. */
interface Window {
  __keepdeckRefresh?: number;
}
