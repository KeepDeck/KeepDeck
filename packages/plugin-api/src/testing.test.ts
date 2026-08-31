import { describe, expect, it } from "vitest";
import { fsStore } from "./testing.ts";

/**
 * The double against the host it stands in for.
 *
 * Every equivalence run that proved a migrated plugin answers what it used to
 * read its files through THIS, not through `project_fs_read_file`. So the
 * whole chain of proof rests on the two agreeing — and three runs built on
 * one double are not three independent confirmations, they are one
 * assumption made three times.
 *
 * Each case below mirrors, one for one, a test in
 * `src-tauri/src/project_fs/read.rs`. They are stated as the CONTRACT rather
 * than as "what the double happens to do", so a change on either side that
 * breaks the correspondence fails here rather than quietly invalidating
 * every result measured through the double.
 *
 * The Rust tests are named beside each case; if one is renamed or deleted,
 * its twin here is what notices.
 */
describe("fsStore mirrors project_fs_read_file", () => {
  /** Rust: read_file_reads_a_window_starting_at_the_offset */
  it("reads a window starting at the offset, counting from there", async () => {
    const fs = fsStore({ "/big.txt": "0123456789abcdef" });

    const file = await fs.readFile("/big.txt", { maxBytes: 4, offset: 10 });

    expect(file.text).toBe("abcd");
    expect(file.readBytes).toBe(4);
    // The FILE's length, not the window's.
    expect(file.size).toBe(16);
    expect(file.truncated).toBe(true);
  });

  /** Rust: read_file_windows_chained_by_offset_reassemble_the_file */
  it("windows chained by offset + readBytes reassemble the file", async () => {
    const content = Array.from({ length: 50 }, (_, i) => `line ${i}\n`).join("");
    const fs = fsStore({ "/log.jsonl": content });

    let at = 0;
    let seen = "";
    for (;;) {
      const file = await fs.readFile("/log.jsonl", { maxBytes: 30, offset: at });
      seen += file.text ?? "";
      at += file.readBytes;
      if (!file.truncated) break;
      expect(file.readBytes).toBeGreaterThan(0);
    }

    expect(seen).toBe(content);
    expect(at).toBe(new TextEncoder().encode(content).length);
  });

  /** Rust: read_file_offset_past_the_end_reads_nothing_and_ends */
  it("an offset at or past the end reads nothing and reports no remainder", async () => {
    const fs = fsStore({ "/a.txt": "hello" });

    const file = await fs.readFile("/a.txt", { offset: 5 });

    expect(file.text).toBe("");
    expect(file.readBytes).toBe(0);
    // "Empty and not truncated" is how a walking reader learns it is done;
    // truncation here would loop it on emptiness.
    expect(file.truncated).toBe(false);
  });

  /** Rust: read_file_window_split_mid_character_resumes_before_it */
  it("a window split mid-character drops the stub AND its bytes", async () => {
    const fs = fsStore({ "/split.txt": "abДef" });

    const first = await fs.readFile("/split.txt", { maxBytes: 3 });
    expect(first.text).toBe("ab");
    // The stub is not in the text, so it must not be in the count either —
    // otherwise the next window starts after a character nobody received.
    expect(first.readBytes).toBe(2);

    const second = await fs.readFile("/split.txt", { offset: first.readBytes });
    expect(second.text).toBe("Дef");
    expect(second.truncated).toBe(false);
  });

  /** Rust: read_file_offset_inside_a_character_is_binary_not_silently_moved */
  it("an offset inside a character is reported, not quietly moved", async () => {
    const fs = fsStore({ "/split.txt": "Дa" });

    const file = await fs.readFile("/split.txt", { offset: 1 });

    expect(file.isBinary).toBe(true);
    expect(file.text).toBeNull();
  });

  /** Rust: read_file_window_split_inside_a_four_byte_character_drops_the_whole_stub
   *
   * A corner NEITHER implementation was written against — added to both sides
   * at once, with the same expected numbers derived from the encoding rather
   * than from either one's behaviour. If the double and the host disagree
   * anywhere, it is likeliest to be somewhere like this. */
  it("a four-byte character split by a window loses all of its stub", async () => {
    const fs = fsStore({ "/wide.txt": "ab😀cd" });

    // Two ASCII bytes, then two of the emoji's four.
    const first = await fs.readFile("/wide.txt", { maxBytes: 4 });
    expect(first.text).toBe("ab");
    expect(first.readBytes).toBe(2);
    expect(first.truncated).toBe(true);

    const second = await fs.readFile("/wide.txt", { offset: first.readBytes });
    expect(second.text).toBe("😀cd");
    expect(second.truncated).toBe(false);
  });

  /** Rust: read_file_a_zero_cap_reads_nothing_but_still_reports_a_remainder
   *
   * The shape that can spin a walking reader forever: truncated, yet not
   * advancing. Pinned on both sides so the reader's guard against it stands
   * on agreed behaviour rather than on an assumption. */
  it("a zero cap reads nothing and still reports a remainder", async () => {
    const fs = fsStore({ "/a.txt": "hello" });

    const file = await fs.readFile("/a.txt", { maxBytes: 0 });

    expect(file.text).toBe("");
    expect(file.readBytes).toBe(0);
    expect(file.truncated).toBe(true);
  });

  /** Rust: read_file_flags_a_binary_file_and_returns_no_text */
  it("a NUL byte makes the read binary", async () => {
    const fs = fsStore({ "/blob.bin": new Uint8Array([0x00, 0x01, 0xff, 0x00]) });

    const file = await fs.readFile("/blob.bin");

    expect(file.isBinary).toBe(true);
    expect(file.text).toBeNull();
  });

  /** Rust: read_file_keeps_a_corrupt_short_read_binary */
  it("a genuinely bad byte stays binary even when the read was also short", async () => {
    // The rescue must not let corruption masquerade as our own cut: a file
    // damaged at byte three would come back as text with a "partly shown"
    // mark, and the reader would blame the ceiling for a hole it did not make.
    const bytes = new Uint8Array([
      ...new TextEncoder().encode("abc"),
      0xff,
      ...new TextEncoder().encode("defghij"),
    ]);
    const fs = fsStore({ "/bad.txt": bytes });

    const file = await fs.readFile("/bad.txt", { maxBytes: 8 });

    expect(file.isBinary).toBe(true);
    expect(file.text).toBeNull();
    expect(file.truncated).toBe(true);
  });

  /** Rust: read_file_keeps_a_whole_file_ending_mid_character_binary */
  it("a file read WHOLE that ends mid-character stays binary", async () => {
    // `truncated` is what tells "the input ended because WE stopped it" from
    // "the file simply ends this way". Rescuing here would hand back text
    // with no shortfall and a silently lost tail.
    const bytes = new Uint8Array([...new TextEncoder().encode("ok"), 0xd0]);
    const fs = fsStore({ "/cut.txt": bytes });

    const file = await fs.readFile("/cut.txt");

    expect(file.isBinary).toBe(true);
    expect(file.text).toBeNull();
    expect(file.truncated).toBe(false);
  });

  /** Rust: read_file_truncates_at_the_cap_and_flags_it */
  it("a read stopped by the cap says so, and says where it stopped", async () => {
    const fs = fsStore({ "/big.txt": "a".repeat(100) });

    const file = await fs.readFile("/big.txt", { maxBytes: 10 });

    expect(file.text).toBe("a".repeat(10));
    expect(file.truncated).toBe(true);
    expect(file.size).toBe(100);
    expect(file.readBytes).toBe(10);
  });

  /** The host clamps a caller's `maxBytes` to its OWN ceiling — which is why
   * a tiny ceiling is a legitimate host, and why the tests of anything that
   * walks a store can put a window boundary every few bytes. */
  it("clamps the caller's ask to the store's own ceiling", async () => {
    const fs = fsStore({ "/big.txt": "a".repeat(100) }, 7);

    const file = await fs.readFile("/big.txt", { maxBytes: 1024 });

    expect(file.readBytes).toBe(7);
    expect(file.truncated).toBe(true);
  });
});
