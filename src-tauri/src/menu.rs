//! The native application menu.
//!
//! Replaces Tauri's default menu so File carries the deck's hotkeys: ⌘T spawns
//! an agent and ⌘W closes the selected one. The default menu binds ⌘W to
//! "Close Window", and macOS resolves menu accelerators before the webview
//! ever sees the key — so the deck can only own these chords by owning the
//! menu. The custom items don't act here: each emits an event the webview
//! handles, where the React side knows what's open, selected, or at cap.

use tauri::menu::{Menu, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

/// Menu item id for "File → New Agent…" (⌘T).
const NEW_AGENT_ID: &str = "new-agent";
/// Webview event for [`NEW_AGENT_ID`]; mirrored in `src/hotkeys.ts`.
pub const NEW_AGENT_EVENT: &str = "deck://menu/new-agent";
/// Menu item id for "File → Close Agent" (⌘W).
const CLOSE_AGENT_ID: &str = "close-agent";
/// Webview event for [`CLOSE_AGENT_ID`]; mirrored in `src/hotkeys.ts`.
pub const CLOSE_AGENT_EVENT: &str = "deck://menu/close-agent";

/// Build the app menu: our File items plus the standard roles. Edit keeps the
/// predefined clipboard items — macOS routes ⌘C/⌘V through the menu, so
/// dropping them would break copy/paste inside the webview. No "Close Window"
/// anywhere: its default ⌘W accelerator would collide with Close Agent.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let new_agent = MenuItemBuilder::with_id(NEW_AGENT_ID, "New Agent…")
        .accelerator("CmdOrCtrl+T")
        .build(app)?;
    let close_agent = MenuItemBuilder::with_id(CLOSE_AGENT_ID, "Close Agent")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;

    let menu = Menu::new(app)?;

    // The application submenu (first slot on macOS).
    #[cfg(target_os = "macos")]
    menu.append(
        &SubmenuBuilder::new(app, "KeepDeck")
            .about(Some(tauri::menu::AboutMetadata::default()))
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?,
    )?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&new_agent)
        .separator()
        .item(&close_agent);
    // Without a macOS application submenu, Quit lives in File.
    #[cfg(not(target_os = "macos"))]
    let file = file.separator().quit();
    menu.append(&file.build()?)?;

    menu.append(
        &SubmenuBuilder::new(app, "Edit")
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .build()?,
    )?;
    menu.append(&SubmenuBuilder::new(app, "View").fullscreen().build()?)?;
    menu.append(
        &SubmenuBuilder::new(app, "Window")
            .minimize()
            .maximize()
            .build()?,
    )?;

    Ok(menu)
}

/// The webview event a menu item id maps to, when the item is one of ours.
fn event_for(id: &str) -> Option<&'static str> {
    match id {
        NEW_AGENT_ID => Some(NEW_AGENT_EVENT),
        CLOSE_AGENT_ID => Some(CLOSE_AGENT_EVENT),
        _ => None,
    }
}

/// Forward a triggered menu item to the webview as its deck event. Predefined
/// items (copy, quit, …) act natively and never reach this map.
pub fn handle_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if let Some(event) = event_for(id) {
        let _ = app.emit(event, ());
    }
}
