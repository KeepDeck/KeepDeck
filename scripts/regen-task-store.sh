#!/usr/bin/env bash
# Regenerate the task store's generated code — the one place that says how:
#   - crates/keepdeck-tasks/src/schema.rs, from the SQL migrations
#     (`diesel print-schema`; Diesel checks every query against it);
#   - src/ipc/generated/tasks/*.ts, the TS side of the store's wire types
#     (ts-rs, run by the crate's export tests).
# Both are committed. CI runs this and fails when the tree changes.
# Needs diesel_cli: cargo install diesel_cli --no-default-features --features sqlite-bundled
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
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
