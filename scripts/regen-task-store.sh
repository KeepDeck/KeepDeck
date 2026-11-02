#!/usr/bin/env bash
# Regenerate the task store's generated code — the one place that says how:
#   - crates/keepdeck-tasks/src/schema.rs, from the SQL migrations
#     (`diesel print-schema`; Diesel checks every query against it);
#   - src/ipc/generated/tasks/*.ts, the TS side of the store's wire types
#     (ts-rs, run by the crate's export tests).
# Both are committed. CI runs this and fails when the tree changes.
# Needs diesel_cli 2.3.13 (CI pins it):
#   cargo install diesel_cli --version '=2.3.13' --no-default-features --features sqlite-bundled --locked
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
# diesel formats schema.rs through rustfmt and, when it cannot run it, writes
# the schema unformatted without a word — a diff that reads as drift. Asked
# from the crate, so it is the rustfmt of the toolchain diesel will get.
if ! (cd "$root/crates/keepdeck-tasks" && rustfmt --version) >/dev/null 2>&1; then
  echo "error: rustfmt does not run here, and diesel print-schema would write schema.rs unformatted — add rustfmt to the toolchain (rust-toolchain.toml lists it)" >&2
  exit 1
fi
db="$(mktemp -d)/schema.db"
(
  cd "$root/crates/keepdeck-tasks"
  diesel migration run --database-url "$db" >/dev/null
  diesel print-schema --database-url "$db" > src/schema.rs
)
rm -rf "$root/src/ipc/generated/tasks"
(cd "$root" && cargo test -q -p keepdeck-tasks --lib export_bindings >/dev/null)
# ts-rs leaves a space at the end of some lines; the repo's diff check
# refuses trailing whitespace, so the generated files are trimmed.
perl -pi -e 's/[ \t]+$//' "$root/src/ipc/generated/tasks/"*.ts
# Every integer crosses IPC as a JS number: an i64 left without
# #[ts(type = "number")] would generate `bigint` and lie about the wire.
if grep -l "bigint" "$root/src/ipc/generated/tasks/"*.ts; then
  echo "error: a generated task type says bigint — mark the field #[ts(type = \"number\")]" >&2
  exit 1
fi
