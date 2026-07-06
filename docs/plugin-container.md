# The `.kdplugin` container

An external KeepDeck plugin ships as **one file**: a `.kdplugin` container.
Installing is putting the file into the plugins folder; uninstalling is
deleting it. The plugin's data (workspace state, settings) lives in
KeepDeck's own documents and survives reinstalls.

```
~/.config/keepdeck/plugins/        (keepdeck-dev in debug builds)
├── Preview.kdplugin               ← one file = one plugin
└── MyWip/                         ← unpacked folder = DEV MODE (badge in settings)
```

The file name is cosmetic — identity comes from the manifest inside.

## Format

A `.kdplugin` is a plain **ZIP archive** (stored entries; any archiver opens
it) with this layout:

| Entry            | Required | Meaning |
|------------------|----------|---------|
| `container.json` | yes      | Written by the packer: `{ "format": 1 }` — the container-format revision. A reader refuses a higher format ("created by a newer KeepDeck"). |
| `manifest.json`  | yes      | The plugin: id, name, version, `minApiVersion`, capabilities, contributions. Validated strictly on load. |
| logic bundle     | no       | Self-contained ESM run in the plugin's logic realm (hooks, storage, events over RPC), declared by the manifest's `logic` field (e.g. `"logic": "logic.js"`) — no field, no realm. No externals — bundle everything, including `@keepdeck/plugin-guest`. |
| `<tabId>.html`   | per dock tab | The document for each `contributes.dockTabs` entry, shown in a sandboxed iframe under the plugin's own origin. Bring your own JS/CSS/framework — the iframe is isolated. |
| `SIGNATURE`      | reserved | Future integrity block. Absent today; readers ignore it. |
| anything else    | no       | Assets, referenced by relative paths only. |

Rules enforced by the packer **and** by the app's reader:

- entry paths are relative, forward-slash, no `..`, no symlinks, no duplicates;
- ≤ 1000 entries, ≤ 20 MB per file, ≤ 50 MB total (uncompressed);
- `manifest.json` passes the strict validator (`readManifest`);
- every declared dock tab has its `<tabId>.html`, and a declared `logic` bundle exists.

Network access from plugin documents is limited by CSP to the domains the
manifest declares in its `net` capability — undeclared hosts are blocked by
the browser, not by review.

## Packing

From the repo:

```sh
node scripts/pack-plugin.mjs ./my-plugin            # → <Name>.kdplugin
node scripts/pack-plugin.mjs ./my-plugin -o out.kdplugin
```

The script validates the tree (listing every problem at once), then writes a
deterministic archive — same tree, byte-identical container. It is the
format's reference implementation; this document is its prose.

No tooling at hand? The format is plain zip, so any archiver works — but the
app refuses a container without `container.json`, so write it yourself first:

```sh
cd my-plugin
printf '{"format":1}\n' > container.json
zip -r ../My.kdplugin .
```

The script remains the recommended path: it validates before packing.

## Developing

Work as an **unpacked folder** in the plugins directory: same layout, no
archive, instant iteration. Dev folders show a `dev` badge in Settings →
Plugins, and a dev folder wins over an installed container with the same
plugin id — iterate on top of the released version, delete the folder to fall
back. Pack when you share.
