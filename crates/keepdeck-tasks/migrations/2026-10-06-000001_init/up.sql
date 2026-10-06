-- The task store's first schema (board-db-design v10 §03). No column holds
-- JSON: every fact a board has is a column, or a row of a table of its own.

-- Numbers are BIGINT (times are ms since the epoch); SQLite stores them as
-- it stores any integer.
CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
) WITHOUT ROWID;

-- A board is a space of tasks with its own counter. Workspace ids are
-- reused, so a board has its own id; `workspace` is null for a board that
-- belongs to none.
CREATE TABLE boards (
    board     TEXT NOT NULL PRIMARY KEY,
    workspace TEXT UNIQUE,
    next_id   BIGINT NOT NULL,
    rev       BIGINT NOT NULL
);

CREATE TABLE tasks (
    uid       TEXT NOT NULL PRIMARY KEY,
    board     TEXT NOT NULL REFERENCES boards(board) ON DELETE CASCADE,
    board_pos BIGINT NOT NULL,
    team_id   TEXT,
    title     TEXT NOT NULL,
    body      TEXT NOT NULL,
    body_v    BIGINT NOT NULL,
    status    TEXT NOT NULL,
    priority  TEXT NOT NULL,
    assignee  TEXT,
    author    TEXT NOT NULL,
    created   BIGINT NOT NULL,
    updated   BIGINT NOT NULL,
    rev       BIGINT NOT NULL
);
CREATE INDEX tasks_by_board ON tasks(board, board_pos);
CREATE INDEX tasks_by_rev ON tasks(board, rev);

-- Every address a task has had: one numbering space per board, a number
-- never handed out twice, exactly one current address per task.
CREATE TABLE task_keys (
    board   TEXT NOT NULL,
    id      TEXT NOT NULL,
    uid     TEXT NOT NULL REFERENCES tasks(uid) ON DELETE CASCADE,
    current BOOLEAN NOT NULL,
    PRIMARY KEY (board, id)
) WITHOUT ROWID;
CREATE UNIQUE INDEX task_keys_current ON task_keys(uid) WHERE current = 1;
CREATE INDEX task_keys_by_uid ON task_keys(uid);

-- An earlier version of a brief: its number and its text. Who replaced it
-- and when is the log's (field = body, was/now = the version numbers).
CREATE TABLE task_briefs (
    uid  TEXT NOT NULL REFERENCES tasks(uid) ON DELETE CASCADE,
    v    BIGINT NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (uid, v)
) WITHOUT ROWID;

CREATE TABLE task_labels (
    uid   TEXT NOT NULL REFERENCES tasks(uid) ON DELETE CASCADE,
    label TEXT NOT NULL,
    PRIMARY KEY (uid, label)
) WITHOUT ROWID;

CREATE TABLE task_artifacts (
    uid      TEXT NOT NULL REFERENCES tasks(uid) ON DELETE CASCADE,
    pos      BIGINT NOT NULL,
    artifact TEXT NOT NULL,
    PRIMARY KEY (uid, pos)
) WITHOUT ROWID;

CREATE TABLE task_comments (
    uid    TEXT NOT NULL REFERENCES tasks(uid) ON DELETE CASCADE,
    n      BIGINT NOT NULL,
    at     BIGINT NOT NULL,
    author TEXT NOT NULL,
    body   TEXT NOT NULL,
    PRIMARY KEY (uid, n)
) WITHOUT ROWID;

CREATE TABLE task_log (
    uid    TEXT NOT NULL REFERENCES tasks(uid) ON DELETE CASCADE,
    seq    BIGINT NOT NULL,
    at     BIGINT NOT NULL,
    author TEXT NOT NULL,
    field  TEXT NOT NULL,
    was    TEXT,
    "now"  TEXT,
    PRIMARY KEY (uid, seq)
) WITHOUT ROWID;

-- No foreign keys: which link outlives which end is the domain's rule
-- (`outlivesItsTo`, and kinds from newer builds kept while an end lives),
-- and a cascade here would be a second, different copy of it.
CREATE TABLE relations (
    kind     TEXT NOT NULL,
    from_uid TEXT NOT NULL,
    to_uid   TEXT NOT NULL,
    at       BIGINT NOT NULL,
    "by"     TEXT,
    PRIMARY KEY (kind, from_uid, to_uid)
) WITHOUT ROWID;
CREATE INDEX relations_by_from ON relations(from_uid);
CREATE INDEX relations_by_to ON relations(to_uid, kind);

-- Requests already applied, so a change sent again after its answer was
-- lost is answered, not applied twice. Kept for the latest few hundred.
CREATE TABLE requests (
    request_id TEXT NOT NULL,
    board      TEXT NOT NULL,
    rev        BIGINT NOT NULL,
    seq        BIGINT NOT NULL,
    -- What the request held (sha-256 of it): the same id with other
    -- content is refused, never answered "already applied".
    digest     TEXT NOT NULL,
    PRIMARY KEY (request_id, board)
) WITHOUT ROWID;
CREATE INDEX requests_by_seq ON requests(seq);

-- Full-text search over a task (title and brief, n = null) and over each
-- of its comments (n = the comment's number). Which document is which
-- lives here, keyed by the index's rowid (an INTEGER PRIMARY KEY, kept
-- through VACUUM): a task's documents are found and removed by key, never
-- by scanning the index.
CREATE TABLE fts_docs (
    doc INTEGER NOT NULL PRIMARY KEY,
    uid TEXT NOT NULL,
    n   BIGINT
);
CREATE INDEX fts_docs_by_uid ON fts_docs(uid, n);
CREATE VIRTUAL TABLE search USING fts5(text);
