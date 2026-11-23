/**
 * Whether a folder under kimi's `sessions/` holds sessions: `wd_<slug>_<hash>`
 * for a directory the TUI runs in, and, since kimi 2.5.0, `wm_<uuid>` for a
 * workspace kimi's web or desktop app made. Both lay their sessions out the
 * same way (`session_<id>/agents/main/wire.jsonl`). kimi's own dot entries
 * (`.index-cache`, `.index-dirty`) are not buckets.
 *
 * The one place the plugin knows this: the history's walk (and the tail's
 * fallback, which reads that walk) and the fork's source check both ask it.
 */
export function isSessionBucket(name: string): boolean {
  return /^w[dm]_/.test(name);
}
