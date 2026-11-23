//! The host harness's binary: the app on Tauri's test runtime, serving the
//! page's tests over its stdin and stdout (see `keepdeck_lib::harness`).

fn main() {
    keepdeck_lib::harness::serve();
}
