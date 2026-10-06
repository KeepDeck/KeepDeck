// @generated automatically by Diesel CLI.

diesel::table! {
    boards (board) {
        board -> Text,
        workspace -> Nullable<Text>,
        next_id -> BigInt,
        rev -> BigInt,
    }
}

diesel::table! {
    fts_docs (doc) {
        doc -> BigInt,
        uid -> Text,
        n -> Nullable<BigInt>,
    }
}

diesel::table! {
    meta (key) {
        key -> Text,
        value -> Text,
    }
}

diesel::table! {
    relations (kind, from_uid, to_uid) {
        kind -> Text,
        from_uid -> Text,
        to_uid -> Text,
        at -> BigInt,
        by -> Nullable<Text>,
    }
}

diesel::table! {
    requests (request_id, board) {
        request_id -> Text,
        board -> Text,
        rev -> BigInt,
        seq -> BigInt,
        digest -> Text,
    }
}

diesel::table! {
    task_artifacts (uid, pos) {
        uid -> Text,
        pos -> BigInt,
        artifact -> Text,
    }
}

diesel::table! {
    task_briefs (uid, v) {
        uid -> Text,
        v -> BigInt,
        body -> Text,
    }
}

diesel::table! {
    task_comments (uid, n) {
        uid -> Text,
        n -> BigInt,
        at -> BigInt,
        author -> Text,
        body -> Text,
        rev -> BigInt,
    }
}

diesel::table! {
    task_keys (board, id) {
        board -> Text,
        id -> Text,
        uid -> Text,
        current -> Bool,
    }
}

diesel::table! {
    task_labels (uid, label) {
        uid -> Text,
        label -> Text,
    }
}

diesel::table! {
    task_log (uid, seq) {
        uid -> Text,
        seq -> BigInt,
        at -> BigInt,
        author -> Text,
        field -> Text,
        was -> Nullable<Text>,
        now -> Nullable<Text>,
        rev -> BigInt,
    }
}

diesel::table! {
    tasks (uid) {
        uid -> Text,
        board -> Text,
        board_pos -> BigInt,
        team_id -> Nullable<Text>,
        title -> Text,
        body -> Text,
        body_v -> BigInt,
        status -> Text,
        priority -> Text,
        assignee -> Nullable<Text>,
        author -> Text,
        created -> BigInt,
        updated -> BigInt,
        rev -> BigInt,
        created_rev -> BigInt,
        kind -> Text,
    }
}

diesel::joinable!(task_artifacts -> tasks (uid));
diesel::joinable!(task_briefs -> tasks (uid));
diesel::joinable!(task_comments -> tasks (uid));
diesel::joinable!(task_keys -> tasks (uid));
diesel::joinable!(task_labels -> tasks (uid));
diesel::joinable!(task_log -> tasks (uid));
diesel::joinable!(tasks -> boards (board));

diesel::allow_tables_to_appear_in_same_query!(
    boards,
    fts_docs,
    meta,
    relations,
    requests,
    task_artifacts,
    task_briefs,
    task_comments,
    task_keys,
    task_labels,
    task_log,
    tasks,
);
