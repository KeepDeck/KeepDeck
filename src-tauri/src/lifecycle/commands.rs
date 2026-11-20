//! The lifecycle's IPC commands: thin doors. Each one sends an event, or asks
//! through the waiting door, or reads the published state — and decides
//! nothing itself.

use super::Lifecycle;
use keepdeck_lifecycle::command::{Outcome, Revision};
use keepdeck_lifecycle::dir::Dir;
use keepdeck_lifecycle::ids::{CommandId, OpId, PermitId, WorkspaceId};
use keepdeck_lifecycle::machine::queries::{self, Claim, Location, PlaceHeld, Preview};
use keepdeck_lifecycle::machine::snapshot::{snapshot, Versioned};
use keepdeck_lifecycle::machine::{Event, LeaseAsk, Load, State};
use keepdeck_lifecycle::model::{Intent, Place, Reply};
use keepdeck_lifecycle::world::DeckFacts;
use tauri::ipc::Channel;

/// How many places the hint asks the disk about before it gives up.
const SUGGEST_TRIES: u32 = 100;

fn state_now(lifecycle: &Lifecycle) -> State {
    // Copied out, the borrow let go at once: the machine publishes under it.
    lifecycle.door().machine().state().borrow().value.clone()
}

/// The snapshot now, then each change, on this channel — the one channel TS
/// hears the machine on.
#[tauri::command]
pub async fn lifecycle_subscribe(lifecycle: tauri::State<'_, Lifecycle>, on_snapshot: Channel<Versioned>) -> Result<(), String> {
    let mut states = lifecycle.door().machine().state();
    tauri::async_runtime::spawn(async move {
        loop {
            let message = {
                let at = states.borrow_and_update();
                Versioned { version: at.version, snapshot: snapshot(&at.value) }
            };
            if on_snapshot.send(message).is_err() || states.changed().await.is_err() {
                return;
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn lifecycle_boot_handshake(lifecycle: tauri::State<'_, Lifecycle>, deck: DeckFacts, load: Load) -> Result<Reply, String> {
    let door = lifecycle.door();
    Ok(door.ask(|ask| Event::Handshake { ask, deck, load }).await)
}

#[tauri::command]
pub async fn lifecycle_intent(lifecycle: tauri::State<'_, Lifecycle>, intent: Intent) -> Result<Reply, String> {
    let door = lifecycle.door();
    Ok(door.ask(|ask| Event::Intent { ask, intent }).await)
}

#[tauri::command]
pub async fn lifecycle_lease(lifecycle: tauri::State<'_, Lifecycle>, lease: LeaseAsk) -> Result<Reply, String> {
    let door = lifecycle.door();
    Ok(door.ask(|ask| Event::Lease { ask, lease }).await)
}

#[tauri::command]
pub fn lifecycle_release(lifecycle: tauri::State<'_, Lifecycle>, permit: PermitId) {
    lifecycle.door().tell(Event::Release { permit });
}

#[tauri::command]
pub fn lifecycle_applied(lifecycle: tauri::State<'_, Lifecycle>, id: CommandId, outcome: Outcome) {
    lifecycle.door().tell(Event::Answered { id, outcome });
}

#[tauri::command]
pub fn lifecycle_hook_ended(lifecycle: tauri::State<'_, Lifecycle>, op: OpId) {
    lifecycle.door().tell(Event::HookEnded { op });
}

#[tauri::command]
pub fn lifecycle_deck_saved(lifecycle: tauri::State<'_, Lifecycle>, revision: Revision) {
    lifecycle.door().tell(Event::DeckSaved { revision });
}

#[tauri::command]
pub fn lifecycle_preview(lifecycle: tauri::State<'_, Lifecycle>, intent: Intent) -> Preview {
    queries::preview(&state_now(&lifecycle), &intent)
}

#[tauri::command]
pub fn lifecycle_claims(lifecycle: tauri::State<'_, Lifecycle>, path: Dir) -> Vec<Claim> {
    queries::claims(&state_now(&lifecycle), &path)
}

/// The place hint, or the verdict on a place typed by hand — the machine's
/// rule first, then the disk's word.
#[tauri::command(async)]
pub fn lifecycle_location(lifecycle: tauri::State<'_, Lifecycle>, workspace: WorkspaceId, candidate: Option<Place>) -> Location {
    let state = state_now(&lifecycle);
    let doors = lifecycle.doors();
    let Some(repo) = state.world.workspaces.get(&workspace).map(|ws| ws.cwd.clone()) else {
        return Location { place: candidate, held: None };
    };
    if let Some(place) = candidate {
        let held = queries::check(&state, &place)
            .or_else(|| doors.probe(&repo, &place.path, &place.branch).then_some(PlaceHeld::Disk));
        return Location { place: Some(place), held };
    }
    let mut from = 1;
    for _ in 0..SUGGEST_TRIES {
        let Some((n, place)) = queries::suggest(&state, &workspace, from) else { break };
        if !doors.probe(&repo, &place.path, &place.branch) {
            return Location { place: Some(place), held: None };
        }
        from = n + 1;
    }
    Location { place: None, held: None }
}
