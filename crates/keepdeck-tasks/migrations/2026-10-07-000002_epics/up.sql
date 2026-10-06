-- Epics (task-297): a task is work or an epic, and a task sits under at
-- most one epic.

-- What a task is. Every task before this step was work. The words are the
-- domain's (no CHECK): the store keeps a kind, it does not judge it.
ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'task';

-- A task's epic is a link like any other (`child-of`, from the task to its
-- epic); a task has one epic at most, whichever build writes it.
CREATE UNIQUE INDEX relations_one_parent ON relations(from_uid) WHERE kind = 'child-of';
