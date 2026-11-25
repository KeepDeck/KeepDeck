//! The app's build script: tauri's, and one correction to where it leaves the
//! bundle's resources for a dev run.

use std::collections::HashMap;
use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use tauri_utils::resources::ResourcePaths;

fn main() {
    // Re-process bundled resources whenever they change: a renamed reporter
    // script once left dev builds resolving a stale copy (the log showed
    // claudeHook=false while the source tree was correct).
    println!("cargo:rerun-if-changed=resources");
    tauri_build::build();
    if let Err(error) = resources_beside_the_binary() {
        panic!("copying the bundle's resources beside the binary failed: {error}");
    }
}

/// A dev run resolves its bundle's resources beside its binary — the built-in
/// plugins' reporters, claude's Mod, opencode's plugin, kimi's companion — and
/// tauri-build copies them three folders up from OUT_DIR, counting on cargo's
/// old `<profile>/build/<pkg>-<hash>/out`. cargo 1.100 lays OUT_DIR out one
/// folder deeper, `<profile>/build/<pkg>/<hash>/out`, so the copy lands in
/// `<profile>/build` and a dev run finds no resource at all: its agents start
/// with nothing of KeepDeck's to report through (tauri-apps/tauri#14790).
///
/// So the resources `bundle.resources` names in tauri.conf.json are copied
/// beside the binary here, from their SOURCES, walked the way tauri-build
/// walks them, each destination's earlier copy removed first. Not from the
/// folder tauri-build copied them to: it never prunes that one, so a reporter
/// removed or renamed in the tree would come back beside the binary from it.
/// Nothing to do where the two places agree: under the old layout, or once
/// tauri-build finds the folder itself. A release bundle is not concerned —
/// the bundler places its resources itself.
fn resources_beside_the_binary() -> io::Result<()> {
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("cargo sets OUT_DIR"));
    let Some(copied) = out_dir.ancestors().nth(3) else {
        return Ok(());
    };
    // The profile folder holds the binary, and its `build` folder every build
    // script's own.
    let Some(profile) = out_dir
        .ancestors()
        .find(|dir| dir.file_name().is_some_and(|name| name == "build"))
        .and_then(Path::parent)
    else {
        return Ok(());
    };
    if copied == profile {
        return Ok(());
    }
    let config: serde_json::Value =
        serde_json::from_str(&fs::read_to_string("tauri.conf.json")?).map_err(io::Error::other)?;
    let Some(named) = config["bundle"]["resources"].as_object() else {
        return Ok(());
    };
    let resources: HashMap<String, String> = named
        .iter()
        .filter_map(|(source, destination)| Some((source.clone(), destination.as_str()?.to_string())))
        .collect();
    for destination in resources.values() {
        remove(&profile.join(destination))?;
    }
    for resource in ResourcePaths::from_map(&resources, true).iter() {
        let resource = resource.map_err(io::Error::other)?;
        let to = profile.join(resource.target());
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(resource.path(), to)?;
    }
    Ok(())
}

/// Remove what an earlier copy left at `path`, a file or a folder.
fn remove(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}
