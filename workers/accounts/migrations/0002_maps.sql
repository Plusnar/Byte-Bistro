-- Maps a player built in the editor, saved to their account (the editor's JSON, version 1).
CREATE TABLE maps (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The editor's own slot id (slot-<time>-<random>), so the same map keeps one row.
  slot_id TEXT NOT NULL,
  name TEXT NOT NULL,
  map TEXT NOT NULL CHECK (json_valid(map) AND length(map) <= 1048576),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, slot_id)
);
