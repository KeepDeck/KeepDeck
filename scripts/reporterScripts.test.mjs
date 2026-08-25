import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_DIR,
  REPORTERS,
  rendered,
  stale,
} from "./sync-reporters.mjs";

/**
 * Each reporter is authored once under resources/reporters/ and shipped as a
 * real file inside every plugin that runs it. These pin the copies to that
 * source rather than to each other: identical-but-both-wrong passes a
 * copy-to-copy comparison, and a fix landing in one plugin and not the others
 * is a per-agent bug no unit test would catch.
 */
describe("reporter shell scripts", () => {
  it("ships every copy exactly as the canonical file renders", () => {
    expect(
      stale(),
      "run `node scripts/sync-reporters.mjs` to refresh these",
    ).toEqual([]);
  });

  it("keeps the shebang on line 1 and the generated banner under it", () => {
    for (const { name } of REPORTERS) {
      const lines = rendered(name).split("\n");
      // A shell script whose first line is a comment has no interpreter line;
      // the banner must never take that slot.
      expect(lines[0], name).toBe("#!/bin/sh");
      expect(lines[1], name).toContain("GENERATED from resources/reporters/");
    }
  });

  it("leaves the canonical files without a banner", () => {
    // A banner in the source would ship doubled, and would tell a reader
    // editing the right file that they are in the wrong one.
    for (const { name } of REPORTERS) {
      const source = readFileSync(join(CANONICAL_DIR, name), "utf8");
      expect(source, name).not.toContain("GENERATED from");
    }
  });

  it("guards envelope size in bytes, not characters", () => {
    // The bridge cap is bytes; ${#var} counts characters under the UTF-8
    // locale every spawn gets. The guard must never regress to it.
    const script = readFileSync(join(CANONICAL_DIR, "kd-status-hook.sh"), "utf8");
    expect(script).toContain("wc -c");
    expect(script).not.toMatch(/\$\{#payload\}"? -gt/);
  });

  it("keeps the reduction threshold under the bridge's own envelope cap", () => {
    // The shell threshold and the cap it exists to stay below live in
    // different languages in different crates, with nothing but this test
    // linking them. They have already drifted once — the shell sat at
    // exactly half the bridge's limit, so every payload in the gap was
    // reduced although it would have been delivered whole. Tighten the cap
    // in Rust without this, and the drift goes the other way: envelopes
    // between the new cap and the stale threshold are forwarded intact and
    // dropped unread, stranding the pane the reduction exists to save.
    const script = readFileSync(join(CANONICAL_DIR, "kd-status-hook.sh"), "utf8");
    // Anchored to the guard's own variable: a bare `-gt` would happily match
    // any later comparison someone adds above it and silently start
    // asserting the wrong number.
    const threshold = script.match(/"\$bytes"\s+-gt\s+(\d+)/);
    expect(threshold, "no byte threshold found in the reporter").not.toBeNull();

    // The cap lives with the composition that enforces it, not with the wire
    // types — see the split in src-tauri/src/bridge/.
    const bridge = readFileSync("src-tauri/src/bridge/mod.rs", "utf8");
    const cap = bridge.match(/MAX_ENVELOPE_BYTES[^=]*=\s*([0-9*\s]+);/);
    expect(cap, "no MAX_ENVELOPE_BYTES found in the bridge").not.toBeNull();
    const capBytes = cap[1]
      .split("*")
      .reduce((product, part) => product * Number(part.trim()), 1);

    // BOTH directions. Too high and an envelope the bridge rejects is
    // forwarded whole, stranding the pane; too low and every payload in the
    // gap is needlessly reduced — the drift that already happened once, when
    // the shell sat at exactly half. The lower bound leaves room only for the
    // wrapper (~170 bytes with uuid-ish pane and token values).
    expect(Number(threshold[1])).toBeLessThan(capBytes - 512);
    expect(Number(threshold[1])).toBeGreaterThan(capBytes - 2048);
  });

  it("agrees with the transport on what a correlation may be", () => {
    // Two grammars for one name. The deck decides whether an envelope is
    // ASKING (and empties the pane's queue to answer it); the transport
    // decides whether the answer can be written at all. They disagreed once:
    // the deck accepted any non-empty string, Rust accepted
    // [A-Za-z0-9_-]{1,64}, and an ask carrying a space made the deck hand
    // over every waiting message to a write that refused — no file, no
    // watchdog, no report, mail gone with the senders told otherwise.
    const rust = readFileSync("src-tauri/src/bridge/spool.rs", "utf8");
    const maxLen = Number(rust.match(/MAX_NAME_LEN:\s*usize\s*=\s*(\d+)/)?.[1]);
    expect(maxLen, "no MAX_NAME_LEN in spool.rs").toBeGreaterThan(0);
    // The permit-list, read out of the predicate rather than assumed — and
    // read WHOLE. Matching two `b == b'X'` clauses out of however many exist
    // would let a third permitted byte be added on the Rust side while this
    // still compared the first two and passed, which is the divergence it is
    // here to catch.
    const predicate = rust.match(
      /pub fn is_usable_name[\s\S]*?\n\}/,
    )?.[0];
    expect(predicate, "no is_usable_name in spool.rs").toBeTruthy();
    const permits = [...predicate.matchAll(/b\s*==\s*b'(.)'/g)].map((m) => m[1]);
    expect(permits.length, "unreadable permit-list").toBeGreaterThan(0);
    expect(predicate, "is_usable_name has grown a rule this guard cannot see")
      .toContain("is_ascii_alphanumeric()");

    const ts = readFileSync("src/app/mail/hookReply.ts", "utf8");
    const deck = ts.match(/USABLE_CORRELATION\s*=\s*\/\^\[([^\]]*)\]\{1,(\d+)\}\$\//);
    expect(deck, "no USABLE_CORRELATION in hookReply.ts").not.toBeNull();

    expect(Number(deck[2])).toBe(maxLen);
    // Same alphabet: alphanumerics plus exactly the Rust permits, however
    // many there are. Compared as a SET — inside a character class the order
    // of `-` and `_` is a spelling choice, and a guard that fails on spelling
    // teaches people to edit the guard.
    const extras = (chars) => [...chars.replace("A-Za-z0-9", "")].sort().join("");
    expect(extras(deck[1])).toBe(extras(permits.join("")));
  });

  it("has the courier and the renderer agreeing on the ask they exchange", () => {
    // Two halves of one round trip that cannot import each other: the
    // renderer is TypeScript compiled into the deck, the courier is a plain
    // JS file opencode loads into its own process. Between them sit two
    // literals, and a mismatch in either is silent in exactly the way that
    // costs mail.
    //
    // The EVENT NAME is how the renderer knows the question is for it — the
    // deck takes the pane's queue before rendering, so a renderer that says
    // "not mine" hands back an empty answer while the messages ride the
    // restore path, every turn, forever. The VERSION is how the courier
    // knows the answer is one it can read; a courier that rejects it drops
    // messages the deck has already booked as delivered.
    const courier = readFileSync(
      "plugins/opencode/resources/mail-courier.js",
      "utf8",
    );
    const renderer = readFileSync("plugins/opencode/src/mail.ts", "utf8");

    const asked = courier.match(/event:\s*\{\s*type:\s*"([^"]+)"/);
    expect(asked, "no asked event type in the courier").not.toBeNull();
    expect(renderer).toContain(`MAIL_ASK_EVENT = "${asked[1]}"`);

    const courierVersion = courier.match(/REPLY_VERSION\s*=\s*(\d+)/);
    expect(courierVersion, "no REPLY_VERSION in the courier").not.toBeNull();
    // Both numbers read out, then compared — a `toContain` on the rendered
    // text would pass with the courier at 1 and the renderer at 10.
    const rendererVersion = renderer.match(/MAIL_REPLY_VERSION\s*=\s*(\d+)/);
    expect(rendererVersion, "no MAIL_REPLY_VERSION in the renderer").not.toBeNull();
    expect(rendererVersion[1]).toBe(courierVersion[1]);
  });

  it("keeps the deck's patience shorter than every asker's, in every language", () => {
    // One relationship with three homes: how long a reporter waits for the
    // deck's answer, against how long the deck holds the connection open.
    //
    // The ordering INVERTED at the cutoff, and it is worth saying why. While
    // an answer was a file, the asker had to give up first: the deck started
    // its own clock when it wrote, and an asker still polling after the deck
    // had discarded the file would find nothing, with the messages already
    // marked handed over. Now the answer travels on the connection, so the
    // deck must give up first — then it answers 504, which an asker can read,
    // instead of leaving it timing out against a socket that says nothing.
    const shell = readFileSync(join(CANONICAL_DIR, "lib/reporter-send.sh"), "utf8");
    const shellWaitMs = Number(shell.match(/^SEND_MAX=([\d.]+)/m)?.[1]) * 1000;
    expect(shellWaitMs, "no SEND_MAX in the shared sender").toBeGreaterThan(0);

    const plugin = readFileSync(
      "plugins/opencode/resources/keepdeck-bridge.js",
      "utf8",
    );
    const pluginWaitMs = Number(
      plugin.match(/SEND_TIMEOUT_MS\s*=\s*(\d[\d_]*)/)?.[1]?.replace(/_/g, ""),
    );
    expect(pluginWaitMs, "no SEND_TIMEOUT_MS in the plugin").toBeGreaterThan(0);

    const waiters = readFileSync("src-tauri/src/bridge/waiters.rs", "utf8");
    const deckWaitMs = Number(
      waiters
        .match(/HOOK_WAIT[^=]*=\s*Duration::from_millis\((\d[\d_]*)\)/)?.[1]
        ?.replace(/_/g, ""),
    );
    expect(deckWaitMs, "no HOOK_WAIT in the bridge").toBeGreaterThan(0);

    // The deck runs out first, so silence always arrives with a status on it.
    expect(deckWaitMs).toBeLessThan(shellWaitMs);
    expect(deckWaitMs).toBeLessThan(pluginWaitMs);
    // And not so far under that a slow round trip is called a miss: the gap
    // is room for the deck's own answer to travel, not a second budget.
    expect(shellWaitMs - deckWaitMs).toBeLessThan(1000);
    expect(pluginWaitMs - deckWaitMs).toBeLessThan(1000);
  });

  it("leaves no reporter writing into the run directory", () => {
    // The cutoff, pinned. Every lane a reporter had for REACHING the deck is
    // the connection now; the run directory carries the doorbell and nothing
    // else. A reporter that started writing envelopes again would be
    // reporting into a directory nothing watches — alive-looking and silent,
    // which is the failure this whole channel exists to make impossible.
    for (const name of readdirSync(CANONICAL_DIR)) {
      if (!name.endsWith(".sh")) continue;
      const body = readFileSync(join(CANONICAL_DIR, name), "utf8");
      const staging = body.match(/^\s*[^#\n]*mktemp\s+"?\$dir/m);
      expect(staging, `${name} still stages a file in the inbox`).toBeNull();
    }
    const shared = readFileSync(
      join(CANONICAL_DIR, "lib/reporter-send.sh"),
      "utf8",
    );
    expect(shared).not.toMatch(/mktemp/);
    const plugin = readFileSync(
      "plugins/opencode/resources/keepdeck-bridge.js",
      "utf8",
    );
    expect(plugin, "the plugin still knows how to write an inbox")
      .not.toMatch(/writeFileSync|renameSync/);
  });
});
