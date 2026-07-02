fn main() {
    // Re-process bundled resources whenever they change: a renamed reporter
    // script once left dev builds resolving a stale copy (the log showed
    // claudeHook=false while the source tree was correct).
    println!("cargo:rerun-if-changed=resources");
    tauri_build::build()
}
