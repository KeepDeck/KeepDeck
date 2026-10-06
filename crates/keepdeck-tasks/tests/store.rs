//! The store's guarantees, one test each: a change lands whole or not at
//! all, is never applied twice, never takes a number back, never rewrites
//! history; a damaged database writes nothing; a backup is verified before
//! it counts; a migration is one step for every board.

use std::path::Path;

use keepdeck_tasks::*;

fn task(uid: &str, key: &str) -> StoredTask {
    StoredTask {
        uid: uid.into(),
        key: key.into(),
        old_keys: vec![],
        team_id: Some("team-1".into()),
        title: format!("Task {key}"),
        body: format!("Brief of {key}"),
        body_v: 1,
        status: "todo".into(),
        priority: "normal".into(),
        assignee: None,
        author: "lead".into(),
        created: 1_000,
        updated: 1_000,
        rev: 0,
        labels: vec![],
        artifacts: vec![],
        comments: vec![],
        log: vec![],
        briefs: vec![],
    }
}

fn board(id: &str, ws: Option<&str>, tasks: Vec<StoredTask>) -> StoredBoard {
    StoredBoard { board: id.into(), workspace: ws.map(Into::into), next_id: tasks.len() as i64 + 1, rev: 0, tasks, relations: vec![] }
}

fn write_of(t: &StoredTask, pos: i64) -> TaskWrite {
    TaskWrite {
        uid: t.uid.clone(),
        board_pos: pos,
        team_id: t.team_id.clone(),
        title: t.title.clone(),
        body: t.body.clone(),
        body_v: t.body_v,
        status: t.status.clone(),
        priority: t.priority.clone(),
        assignee: t.assignee.clone(),
        author: t.author.clone(),
        created: t.created,
        updated: t.updated,
        key: None,
        labels: None,
        artifacts: None,
        comments: vec![],
        log: vec![],
        briefs: vec![],
    }
}

fn change(id: &str, boards: Vec<BoardChange>) -> ChangeSet {
    ChangeSet { request_id: id.into(), boards }
}

fn board_change(board: &str, expected_rev: i64, next_id: i64, tasks: Vec<TaskWrite>) -> BoardChange {
    BoardChange {
        board: board.into(),
        workspace: None,
        expected_rev,
        next_id,
        tasks,
        removed: vec![],
        relations_put: vec![],
        relations_removed: vec![],
    }
}

/// A store whose boards have moved: one board `b1` of workspace `ws-1` with
/// task-1 and task-2.
fn active_store(root: &Path) -> Store {
    let mut store = Store::open(root).unwrap();
    store.import(&[board("b1", Some("ws-1"), vec![task("u1", "task-1"), task("u2", "task-2")])], &[]).unwrap();
    store.activate_migration().unwrap();
    store
}

/// What the ticker does: decide under the lock, copy outside it, record.
fn backup_if_due(store: &mut Store, now_ms: i64) -> Result<Option<backup::Backup>> {
    let Some(job) = store.backup_due(now_ms)? else { return Ok(None) };
    let taken = job.take()?;
    store.backup_taken(&job);
    Ok(Some(taken))
}

fn rev_of(store: &mut Store, b: &str) -> i64 {
    store.load(b).unwrap().rev
}

#[test]
fn opens_durable_wal_with_foreign_keys() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    assert_eq!(store.status().unwrap(), StoreStatus::Ready { migration: MigrationState::None });
    drop(store);
    // The WAL is a property of the file: it is still on after a reopen.
    let conn = rusqlite_free_check(dir.path());
    assert_eq!(conn, "wal");
    // Reopening runs no migration twice.
    Store::open(dir.path()).unwrap();
}

/// The journal mode, read the way any other program would read it.
fn rusqlite_free_check(root: &Path) -> String {
    use diesel::prelude::*;
    #[derive(diesel::QueryableByName)]
    struct Mode {
        #[diesel(sql_type = diesel::sql_types::Text)]
        journal_mode: String,
    }
    let mut conn = diesel::SqliteConnection::establish(&root.join("tasks.db").to_string_lossy()).unwrap();
    let mode: Vec<Mode> = diesel::sql_query("PRAGMA journal_mode").load(&mut conn).unwrap();
    mode[0].journal_mode.clone()
}

#[test]
fn refuses_a_database_a_newer_build_migrated() {
    use diesel::prelude::*;
    let dir = tempfile::tempdir().unwrap();
    drop(Store::open(dir.path()).unwrap());
    let mut conn = diesel::SqliteConnection::establish(&dir.path().join("tasks.db").to_string_lossy()).unwrap();
    diesel::sql_query("INSERT INTO __diesel_schema_migrations(version) VALUES ('2099-01-01-000000')")
        .execute(&mut conn)
        .unwrap();
    drop(conn);
    let mut store = Store::open(dir.path()).unwrap();
    assert!(matches!(store.status().unwrap(), StoreStatus::TooNew { .. }));
    assert!(matches!(store.load_workspace("ws-1"), Err(StoreError::SchemaTooNew { .. })));
}

#[test]
fn a_migration_is_pending_until_activated_and_no_write_lands_before() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    let imported = board("b1", Some("ws-1"), vec![task("u1", "task-1")]);
    store.import(std::slice::from_ref(&imported), &[MigrationSource { workspace: "ws-1".into(), checksum: "abc".into() }]).unwrap();
    assert_eq!(store.migration_state().unwrap(), MigrationState::Pending);
    assert_eq!(store.migration_sources().unwrap(), vec![MigrationSource { workspace: "ws-1".into(), checksum: "abc".into() }]);
    // Read back exactly as imported.
    assert_eq!(store.load_all().unwrap(), vec![imported]);
    // Nothing is written while the files are still the source.
    let refused = store.apply(&change("r1", vec![board_change("b1", 0, 2, vec![])]));
    assert!(matches!(refused, Err(StoreError::Invalid { .. })));
    store.activate_migration().unwrap();
    assert_eq!(store.migration_state().unwrap(), MigrationState::Active);
    assert!(store.migration_sources().unwrap().is_empty());
    // A second migration never lands on top of data.
    assert!(store.import(&[board("b2", Some("ws-2"), vec![])], &[]).is_err());
}

#[test]
fn a_discarded_migration_leaves_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    store.import(&[board("b1", Some("ws-1"), vec![task("u1", "task-1")])], &[]).unwrap();
    store.discard_migration().unwrap();
    assert_eq!(store.migration_state().unwrap(), MigrationState::None);
    assert!(store.load_all().unwrap().is_empty());
    assert!(store.search("Task", &[], 10).unwrap().is_empty());
}

#[test]
fn the_import_names_what_it_refused() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    let mut t = task("u1", "task-1");
    let c = StoredComment { n: 1, at: 1, author: "lead".into(), body: "x".into() };
    t.comments = vec![c.clone(), c];
    let error = store.import(&[board("b1", Some("ws-1"), vec![t])], &[]).unwrap_err();
    let StoreError::Constraint { detail } = error else { panic!("{error:?}") };
    assert!(detail.contains("task task-1 on board b1: comment 1"), "{detail}");
    // And nothing of it stays.
    assert_eq!(store.migration_state().unwrap(), MigrationState::None);
}

#[test]
fn round_trips_every_part_of_a_board() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    let mut t = task("u1", "task-1");
    t.labels = vec!["storage".into(), "ui".into()];
    t.artifacts = vec!["zeta".into(), "alpha".into()];
    t.comments = vec![StoredComment { n: 1, at: 5, author: "impl-1".into(), body: "first".into() }];
    t.log = vec![StoredLogEntry { seq: 0, at: 6, author: "lead".into(), field: "status".into(), was: Some("todo".into()), now: Some("review".into()) }];
    t.briefs = vec![StoredBrief { v: 1, body: "old brief".into() }];
    t.body_v = 2;
    t.old_keys = vec![StoredKey { board: "b0".into(), id: "task-9".into() }];
    let mut b = board("b1", Some("ws-1"), vec![task("u2", "task-2"), t]);
    b.relations = vec![StoredRelation { kind: "blocks".into(), from: "u2".into(), to: "u1".into(), at: 7, by: None }];
    store.import(&[b.clone()], &[]).unwrap();
    assert_eq!(store.load("b1").unwrap(), b);
}

#[test]
fn applies_a_change_and_bumps_the_rev() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = active_store(dir.path());
    let mut t = store.load("b1").unwrap().tasks[0].clone();
    t.status = "in-progress".into();
    let mut w = write_of(&t, 0);
    w.log = vec![StoredLogEntry { seq: 0, at: 9, author: "impl-1".into(), field: "status".into(), was: Some("todo".into()), now: Some("in-progress".into()) }];
    let applied = store.apply(&change("r1", vec![board_change("b1", 0, 3, vec![w])])).unwrap();
    assert_eq!(applied, Applied::Applied { revs: vec![BoardRev { board: "b1".into(), rev: 1 }] });
    let loaded = store.load("b1").unwrap();
    assert_eq!(loaded.rev, 1);
    assert_eq!(loaded.tasks[0].status, "in-progress");
    assert_eq!(loaded.tasks[0].rev, 1);
    assert_eq!(loaded.tasks[0].log.len(), 1);
    // The untouched task keeps its rev: `since` reads from it.
    assert_eq!(loaded.tasks[1].rev, 0);
}

#[test]
fn a_request_sent_again_is_answered_not_applied_twice() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = active_store(dir.path());
    let t = store.load("b1").unwrap().tasks[0].clone();
    let mut w = write_of(&t, 0);
    w.comments = vec![StoredComment { n: 1, at: 9, author: "impl-1".into(), body: "done".into() }];
    let first = change("r1", vec![board_change("b1", 0, 3, vec![w])]);
    store.apply(&first).unwrap();
    let again = store.apply(&first).unwrap();
    assert_eq!(again, Applied::AlreadyApplied { revs: vec![BoardRev { board: "b1".into(), rev: 1 }] });
    assert_eq!(rev_of(&mut store, "b1"), 1);
    assert_eq!(store.load("b1").unwrap().tasks[0].comments.len(), 1);
}

#[test]
fn a_change_against_another_rev_is_a_conflict() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = active_store(dir.path());
    store.apply(&change("r1", vec![board_change("b1", 0, 3, vec![])])).unwrap();
    // A different request computed against rev 0 is not "already applied".
    let stale = store.apply(&change("r2", vec![board_change("b1", 0, 3, vec![])]));
    assert_eq!(stale, Err(StoreError::Conflict { board: "b1".into(), rev: 1 }));
}

#[test]
fn the_counter_never_goes_back() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = active_store(dir.path());
    let back = store.apply(&change("r1", vec![board_change("b1", 0, 2, vec![])]));
    assert!(matches!(back, Err(StoreError::Constraint { .. })), "{back:?}");
}

#[test]
fn history_is_appended_never_rewritten() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = active_store(dir.path());
    let t = store.load("b1").unwrap().tasks[0].clone();
    let c1 = StoredComment { n: 1, at: 9, author: "impl-1".into(), body: "done".into() };
    let mut w = write_of(&t, 0);
    w.comments = vec![c1.clone()];
    store.apply(&change("r1", vec![board_change("b1", 0, 3, vec![w.clone()])])).unwrap();
    // The same comment sent again with a new one: no change to the first.
    let c2 = StoredComment { n: 2, at: 10, author: "lead".into(), body: "ok".into() };
    w.comments = vec![c1.clone(), c2];
    store.apply(&change("r2", vec![board_change("b1", 1, 3, vec![w.clone()])])).unwrap();
    assert_eq!(store.load("b1").unwrap().tasks[0].comments.len(), 2);
    // Stored comment 1 sent with other words: refused, nothing of r3 lands.
    w.comments = vec![StoredComment { body: "rewritten".into(), ..c1 }];
    let rewrite = store.apply(&change("r3", vec![board_change("b1", 2, 3, vec![w.clone()])]));
    assert!(matches!(rewrite, Err(StoreError::Constraint { .. })), "{rewrite:?}");
    assert_eq!(rev_of(&mut store, "b1"), 2);
    // A log entry past the end leaves a gap: refused.
    w.comments = vec![];
    w.log = vec![StoredLogEntry { seq: 3, at: 1, author: "lead".into(), field: "status".into(), was: None, now: None }];
    let gap = store.apply(&change("r4", vec![board_change("b1", 2, 3, vec![w])]));
    assert!(matches!(gap, Err(StoreError::Constraint { .. })), "{gap:?}");
}

#[test]
fn a_number_is_never_handed_out_twice_and_a_move_keeps_the_old_address() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = active_store(dir.path());
    // task-2 moves to a new board b2 as task-1 there; task-2 on b1 stays its old address.
    let t = store.load("b1").unwrap().tasks[1].clone();
    let mut moved = write_of(&t, 0);
    moved.key = Some("task-1".into());
    let mut to = board_change("b2", 0, 2, vec![moved]);
    to.workspace = Some("ws-2".into());
    store.apply(&change("r1", vec![to, board_change("b1", 0, 3, vec![])])).unwrap();
    let b2 = store.load("b2").unwrap();
    assert_eq!(b2.tasks[0].key, "task-1");
    assert_eq!(b2.tasks[0].old_keys, vec![StoredKey { board: "b1".into(), id: "task-2".into() }]);
    assert_eq!(store.load("b1").unwrap().tasks.len(), 1);
    // b1 can never give task-2 to anyone else.
    let mut fresh = write_of(&task("u9", "task-2"), 1);
    fresh.key = Some("task-2".into());
    let reuse = store.apply(&change("r2", vec![board_change("b1", 1, 3, vec![fresh])]));
    assert!(matches!(reuse, Err(StoreError::Constraint { .. })), "{reuse:?}");
}

#[test]
fn a_task_leaves_its_board_only_in_a_change_that_names_that_board() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = active_store(dir.path());
    let t = store.load("b1").unwrap().tasks[0].clone();
    let mut moved = write_of(&t, 0);
    moved.key = Some("task-1".into());
    let mut to = board_change("b2", 0, 2, vec![moved]);
    to.workspace = Some("ws-2".into());
    let silent = store.apply(&change("r1", vec![to]));
    assert!(matches!(silent, Err(StoreError::Constraint { .. })), "{silent:?}");
    assert_eq!(store.load("b1").unwrap().tasks.len(), 2);
    assert_eq!(rev_of(&mut store, "b1"), 0);
}

#[test]
fn one_board_that_does_not_hold_together_leaves_the_others_and_the_backups_working() {
    use diesel::prelude::*;
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    store.import(&[board("b1", Some("ws-1"), vec![task("u1", "task-1")]), board("b2", Some("ws-2"), vec![task("u2", "task-1")])], &[]).unwrap();
    store.activate_migration().unwrap();
    drop(store);
    let mut conn = diesel::SqliteConnection::establish(&dir.path().join("tasks.db").to_string_lossy()).unwrap();
    diesel::sql_query("DELETE FROM task_keys WHERE uid = 'u1'").execute(&mut conn).unwrap();
    drop(conn);
    let mut store = Store::open(dir.path()).unwrap();
    assert!(matches!(store.load("b1"), Err(StoreError::Inconsistent { board, .. }) if board == "b1"));
    // The database is sound: the other board reads and writes, backups go on.
    assert_eq!(store.load("b2").unwrap().tasks.len(), 1);
    store.apply(&change("r1", vec![board_change("b2", 0, 2, vec![])])).unwrap();
    assert!(matches!(store.status().unwrap(), StoreStatus::Ready { .. }));
    assert!(backup_if_due(&mut store, 1).unwrap().is_some());
}

#[test]
fn a_change_over_several_boards_lands_whole_or_not_at_all() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = active_store(dir.path());
    let b1 = store.load("b1").unwrap();
    // b1's part is fine; b2's part puts two tasks at one place.
    let mut ok = write_of(&b1.tasks[0], 0);
    ok.title = "renamed".into();
    let mut a = write_of(&task("u7", "task-1"), 0);
    a.key = Some("task-1".into());
    let mut b = write_of(&task("u8", "task-2"), 0);
    b.key = Some("task-2".into());
    let bad = store.apply(&change("r1", vec![board_change("b1", 0, 3, vec![ok]), board_change("b2", 0, 3, vec![a, b])]));
    assert!(matches!(bad, Err(StoreError::Constraint { .. })), "{bad:?}");
    assert_eq!(store.load("b1").unwrap().tasks[0].title, "Task task-1");
    assert!(store.load("b2").is_err());
}

#[test]
fn links_carry_their_metadata_and_a_dangling_one_stays_with_its_live_end() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = active_store(dir.path());
    let put = |at: i64, by: Option<&str>| StoredRelation { kind: "blocks".into(), from: "u1".into(), to: "u2".into(), at, by: by.map(Into::into) };
    let mut c = board_change("b1", 0, 3, vec![]);
    c.relations_put = vec![put(5, Some("lead"))];
    store.apply(&change("r1", vec![c])).unwrap();
    // The same link put again with new metadata (removed and re-added).
    let mut c = board_change("b1", 1, 3, vec![]);
    c.relations_put = vec![put(9, None)];
    store.apply(&change("r2", vec![c])).unwrap();
    assert_eq!(store.load("b1").unwrap().relations, vec![put(9, None)]);
    // A link of an unknown kind whose `from` end left: still read with its `to` end's board.
    let mut c = board_change("b1", 2, 3, vec![]);
    c.relations_put = vec![StoredRelation { kind: "future-kind".into(), from: "gone".into(), to: "u1".into(), at: 1, by: None }];
    c.relations_removed = vec![RelationKey { kind: "blocks".into(), from: "u1".into(), to: "u2".into() }];
    store.apply(&change("r3", vec![c])).unwrap();
    let relations = store.load("b1").unwrap().relations;
    assert_eq!(relations.len(), 1);
    assert_eq!(relations[0].kind, "future-kind");
}

#[test]
fn labels_are_a_set_and_artifacts_keep_their_order() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = active_store(dir.path());
    let t = store.load("b1").unwrap().tasks[0].clone();
    let mut w = write_of(&t, 0);
    w.labels = Some(vec!["b".into(), "a".into()]);
    w.artifacts = Some(vec!["second".into(), "first".into()]);
    store.apply(&change("r1", vec![board_change("b1", 0, 3, vec![w.clone()])])).unwrap();
    let loaded = store.load("b1").unwrap().tasks[0].clone();
    assert_eq!(loaded.labels, vec!["a".to_string(), "b".to_string()]);
    assert_eq!(loaded.artifacts, vec!["second".to_string(), "first".to_string()]);
    // A pure reorder is a change.
    w.artifacts = Some(vec!["first".into(), "second".into()]);
    store.apply(&change("r2", vec![board_change("b1", 1, 3, vec![w])])).unwrap();
    assert_eq!(store.load("b1").unwrap().tasks[0].artifacts, vec!["first".to_string(), "second".to_string()]);
}

#[test]
fn a_removed_task_takes_its_own_rows_and_its_search() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = active_store(dir.path());
    let mut c = board_change("b1", 0, 3, vec![]);
    c.removed = vec!["u1".into()];
    store.apply(&change("r1", vec![c])).unwrap();
    let b1 = store.load("b1").unwrap();
    assert_eq!(b1.tasks.iter().map(|t| t.key.as_str()).collect::<Vec<_>>(), vec!["task-2"]);
    assert!(store.search("task-1", &[], 10).unwrap().iter().all(|hit| hit.uid != "u1"));
}

#[test]
fn search_finds_tasks_and_comments_ranked_and_scoped() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    let mut a = task("u1", "task-1");
    a.title = "Move the board to SQLite".into();
    let mut b = task("u2", "task-2");
    b.comments = vec![StoredComment { n: 1, at: 1, author: "lead".into(), body: "we discussed sqlite backups here".into() }];
    let other = task("u3", "task-1");
    store.import(&[board("b1", Some("ws-1"), vec![a, b]), board("b2", Some("ws-2"), vec![other])], &[]).unwrap();
    let hits = store.search("sqlite", &[], 10).unwrap();
    assert_eq!(hits.len(), 2);
    assert!(hits.iter().any(|h| h.uid == "u2" && h.comment == Some(1) && h.snippet.contains("[sqlite]")));
    // A word being typed already matches.
    assert_eq!(store.search("SQLi", &[], 10).unwrap().len(), 2);
    // Syntax in the words is text, not a query error.
    assert!(store.search("sqlite\" OR -", &[], 10).is_ok());
    // Scoped to a board.
    assert!(store.search("brief", &["b2".into()], 10).unwrap().iter().all(|h| h.board == "b2"));
}

#[test]
fn dropping_a_workspace_takes_its_board() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = active_store(dir.path());
    assert!(store.drop_workspace("ws-1").unwrap());
    assert_eq!(store.load_workspace("ws-1").unwrap(), None);
    assert!(!store.drop_workspace("ws-1").unwrap());
}

#[test]
fn backups_are_verified_kept_three_and_taken_when_due() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = active_store(dir.path());
    let hour = backup::BACKUP_EVERY_MS;
    // None yet: due at once.
    assert!(backup_if_due(&mut store, 10).unwrap().is_some());
    // Within the hour: not due, changed or not.
    store.apply(&change("r1", vec![board_change("b1", 0, 3, vec![])])).unwrap();
    assert!(backup_if_due(&mut store, 10 + hour - 1).unwrap().is_none());
    // An hour on, after a change: due.
    assert!(backup_if_due(&mut store, 10 + hour).unwrap().is_some());
    // An hour more with no change: not due.
    assert!(backup_if_due(&mut store, 10 + 2 * hour).unwrap().is_none());
    for i in 1..=3 {
        store.apply(&change(&format!("s{i}"), vec![board_change("b1", i, 3, vec![])])).unwrap();
        assert!(backup_if_due(&mut store, 10 + (2 + i) * hour).unwrap().is_some());
    }
    let kept = backup::list(&store.backup_dir()).unwrap();
    assert_eq!(kept.len(), 3);
    assert_eq!(kept[0].at, 10 + 5 * hour);
    // A copy is a whole database.
    let mut copy = Store::open(&tempdir_with(&kept[0].path)).unwrap();
    assert_eq!(copy.load("b1").unwrap().rev, 4);
}

#[test]
fn a_write_that_lands_while_a_backup_is_copied_is_not_counted_as_backed_up() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = active_store(dir.path());
    let hour = backup::BACKUP_EVERY_MS;
    let job = store.backup_due(10).unwrap().unwrap();
    store.apply(&change("r1", vec![board_change("b1", 0, 3, vec![])])).unwrap();
    job.take().unwrap();
    store.backup_taken(&job);
    assert!(store.backup_due(10 + hour).unwrap().is_some());
}

#[test]
fn a_clock_that_was_ahead_neither_stops_the_backups_nor_keeps_its_copy() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = active_store(dir.path());
    let hour = backup::BACKUP_EVERY_MS;
    let ahead = 4_000_000_000_000; // the year 2096
    backup_if_due(&mut store, ahead).unwrap().unwrap();
    // The clock is right again: a change is backed up within the hour.
    store.apply(&change("r1", vec![board_change("b1", 0, 3, vec![])])).unwrap();
    assert!(backup_if_due(&mut store, 10 * hour).unwrap().is_some());
    for i in 1..=2 {
        store.apply(&change(&format!("s{i}"), vec![board_change("b1", i, 3, vec![])])).unwrap();
        assert!(backup_if_due(&mut store, (10 + i) * hour).unwrap().is_some());
    }
    // Three copies taken by the right clock: the one from "2096" went first.
    let kept: Vec<i64> = backup::list(&store.backup_dir()).unwrap().iter().map(|b| b.at).collect();
    assert_eq!(kept, vec![12 * hour, 11 * hour, 10 * hour]);
}

#[test]
fn changes_an_earlier_session_made_after_the_newest_backup_are_backed_up_without_a_new_one() {
    let dir = tempfile::tempdir().unwrap();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    let hour = backup::BACKUP_EVERY_MS;
    let mut store = active_store(dir.path());
    // The newest backup is two hours old; the database was written since.
    backup_if_due(&mut store, now - 2 * hour).unwrap().unwrap();
    store.apply(&change("r1", vec![board_change("b1", 0, 3, vec![])])).unwrap();
    drop(store);
    let mut store = Store::open(dir.path()).unwrap();
    assert!(store.backup_due(now).unwrap().is_some());
    backup_if_due(&mut store, now + 60_000).unwrap().unwrap();
    drop(store);
    // Nothing written after the newest backup: none due, however old it gets.
    let mut store = Store::open(dir.path()).unwrap();
    assert!(store.backup_due(now + 3 * hour).unwrap().is_none());
}

/// A fresh root holding `db` as its tasks.db.
fn tempdir_with(db: &Path) -> std::path::PathBuf {
    let root = tempfile::tempdir().unwrap().keep();
    std::fs::copy(db, root.join("tasks.db")).unwrap();
    root
}

#[test]
fn a_damaged_database_writes_nothing_and_is_restored_from_a_verified_backup() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = active_store(dir.path());
    let taken = backup_if_due(&mut store, 1).unwrap().unwrap();
    drop(store);
    // A backup that fails the check is not offered.
    let bad = store_backup_named(dir.path(), 2);
    std::fs::write(&bad, b"not a database").unwrap();
    // The database itself is damaged.
    std::fs::write(dir.path().join("tasks.db"), b"garbage that is not sqlite at all, for sure").unwrap();
    let _ = std::fs::remove_file(dir.path().join("tasks.db-wal"));
    let mut store = Store::open(dir.path()).unwrap();
    let StoreStatus::Damaged { backups, .. } = store.status().unwrap() else { panic!("not damaged") };
    assert_eq!(backups, vec![taken.at]);
    assert!(matches!(store.load("b1"), Err(StoreError::Corrupt { .. })));
    assert!(backup_if_due(&mut store, 10_000_000).unwrap().is_none());
    store.restore_backup(taken.at, 99).unwrap();
    assert_eq!(store.load("b1").unwrap().tasks.len(), 2);
    // The damaged file is kept aside, not deleted.
    assert!(dir.path().join("tasks.db.damaged-99").exists());
}

#[test]
fn a_restore_that_fails_on_the_way_leaves_the_damaged_store_as_it_was() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = active_store(dir.path());
    let taken = backup_if_due(&mut store, 1).unwrap().unwrap();
    drop(store);
    let garbage = b"garbage that is not sqlite at all, for sure";
    std::fs::write(dir.path().join("tasks.db"), garbage).unwrap();
    let _ = std::fs::remove_file(dir.path().join("tasks.db-wal"));
    let mut store = Store::open(dir.path()).unwrap();
    // The copy cannot be written where the candidate is built.
    std::fs::create_dir(dir.path().join("tasks.db.restoring")).unwrap();
    assert!(matches!(store.restore_backup(taken.at, 99), Err(StoreError::Io { .. })));
    // Still damaged — not off — and the damaged file where it was.
    assert!(matches!(store.status().unwrap(), StoreStatus::Damaged { .. }));
    assert!(matches!(store.load("b1"), Err(StoreError::Corrupt { .. })));
    assert_eq!(std::fs::read(dir.path().join("tasks.db")).unwrap(), garbage);
    assert!(!dir.path().join("tasks.db.damaged-99").exists());
    // Once the way is clear, the same restore goes through.
    std::fs::remove_dir(dir.path().join("tasks.db.restoring")).unwrap();
    store.restore_backup(taken.at, 99).unwrap();
    assert_eq!(store.load("b1").unwrap().tasks.len(), 2);
    assert!(!dir.path().join("tasks.db.restoring").exists());
}

#[test]
fn a_restore_candidate_that_fails_its_check_is_removed_before_anything_moves() {
    let dir = tempfile::tempdir().unwrap();
    let staged = dir.path().join("tasks.db.restoring");
    let built = db::stage(&staged, |path| {
        std::fs::write(path, b"half a copy").unwrap();
        Ok(())
    });
    assert!(built.is_err());
    assert!(!staged.exists());
}

fn remove_database(root: &Path) {
    for name in ["tasks.db", "tasks.db-wal", "tasks.db-shm"] {
        let _ = std::fs::remove_file(root.join(name));
    }
}

#[test]
fn a_missing_database_beside_its_backups_is_never_created_empty_in_silence() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = active_store(dir.path());
    let taken = backup_if_due(&mut store, 1).unwrap().unwrap();
    drop(store);
    remove_database(dir.path());
    let mut store = Store::open(dir.path()).unwrap();
    let StoreStatus::Missing { backups, .. } = store.status().unwrap() else { panic!("not missing") };
    assert_eq!(backups, vec![taken.at]);
    assert!(matches!(store.load_all(), Err(StoreError::Missing { .. })));
    assert!(!dir.path().join("tasks.db").exists());
    // The person restores the backup: every board is back.
    store.restore_backup(taken.at, 99).unwrap();
    assert_eq!(store.load("b1").unwrap().tasks.len(), 2);
}

#[test]
fn a_missing_or_damaged_database_with_no_backup_is_started_empty_by_the_person_only() {
    let dir = tempfile::tempdir().unwrap();
    drop(active_store(dir.path()));
    let garbage = b"garbage that is not sqlite at all, for sure";
    std::fs::write(dir.path().join("tasks.db"), garbage).unwrap();
    let _ = std::fs::remove_file(dir.path().join("tasks.db-wal"));
    let mut store = Store::open(dir.path()).unwrap();
    assert_eq!(store.status().unwrap(), StoreStatus::Damaged { detail: store.load("b1").unwrap_err().to_string(), backups: vec![] });
    store.start_empty(5).unwrap();
    assert_eq!(store.status().unwrap(), StoreStatus::Ready { migration: MigrationState::Active });
    assert_eq!(store.load_all().unwrap(), vec![]);
    assert_eq!(std::fs::read(dir.path().join("tasks.db.damaged-5")).unwrap(), garbage);
    drop(store);
    // Gone again: the copy set aside says there was a database here.
    remove_database(dir.path());
    let mut store = Store::open(dir.path()).unwrap();
    assert!(matches!(store.status().unwrap(), StoreStatus::Missing { backups, .. } if backups.is_empty()));
    store.start_empty(6).unwrap();
    assert_eq!(store.status().unwrap(), StoreStatus::Ready { migration: MigrationState::Active });
    // A healthy one is not started over.
    assert!(matches!(store.start_empty(7), Err(StoreError::Invalid { .. })));
}

#[test]
fn a_healthy_database_is_never_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = active_store(dir.path());
    let taken = backup_if_due(&mut store, 1).unwrap().unwrap();
    assert!(matches!(store.restore_backup(taken.at, 99), Err(StoreError::Invalid { .. })));
    assert!(!dir.path().join("tasks.db.damaged-99").exists());
    assert_eq!(store.load("b1").unwrap().tasks.len(), 2);
}

fn store_backup_named(root: &Path, at: i64) -> std::path::PathBuf {
    root.join("backups").join(format!("tasks-{at}.db"))
}

#[test]
fn a_backup_that_fails_its_check_never_enters_the_set() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = active_store(dir.path());
    backup_if_due(&mut store, 1).unwrap().unwrap();
    store.apply(&change("r1", vec![board_change("b1", 0, 3, vec![])])).unwrap();
    backup_if_due(&mut store, 1 + backup::BACKUP_EVERY_MS).unwrap().unwrap();
    store.apply(&change("r2", vec![board_change("b1", 1, 3, vec![])])).unwrap();
    backup_if_due(&mut store, 1 + 2 * backup::BACKUP_EVERY_MS).unwrap().unwrap();
    let before = backup::list(&store.backup_dir()).unwrap();
    assert_eq!(before.len(), 3);
    // A fourth, newer copy that is not a database: refused, the three untouched.
    let candidate = store.backup_dir().join("candidate.tmp");
    std::fs::write(&candidate, b"half a copy").unwrap();
    assert!(backup::admit(&candidate, &store.backup_dir(), 9 * backup::BACKUP_EVERY_MS).is_err());
    assert_eq!(backup::list(&store.backup_dir()).unwrap(), before);
    assert!(!candidate.exists());
}

#[test]
fn a_migration_never_lands_on_boards_already_there() {
    use diesel::prelude::*;
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path()).unwrap();
    store.import(&[board("b1", Some("ws-1"), vec![task("u1", "task-1")])], &[]).unwrap();
    drop(store);
    // Boards present, the migration's mark gone.
    let mut conn = diesel::SqliteConnection::establish(&dir.path().join("tasks.db").to_string_lossy()).unwrap();
    diesel::sql_query("DELETE FROM meta WHERE key = 'migration'").execute(&mut conn).unwrap();
    drop(conn);
    let mut store = Store::open(dir.path()).unwrap();
    assert!(store.import(&[board("b2", Some("ws-2"), vec![])], &[]).is_err());
    assert_eq!(store.load_all().unwrap().len(), 1);
}
