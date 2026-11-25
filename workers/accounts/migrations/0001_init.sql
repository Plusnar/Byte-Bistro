-- Byte Bistro accounts: username + password, sessions and one save per player.
-- Apply: npx wrangler d1 migrations apply byte-bistro-accounts --remote --config workers/accounts/wrangler.toml

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  -- Shown as typed; compared without case, so "Chef" and "chef" are the same account.
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  -- PBKDF2-SHA256: hash and salt in base64url, with the iteration count it was made with,
  -- so the cost can be raised later without locking anyone out.
  pass_hash TEXT NOT NULL,
  pass_salt TEXT NOT NULL,
  pass_iter INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  -- Wrong passwords in a row, and until when the account refuses logins because of them.
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sessions (
  -- SHA-256 of the cookie token: a leaked table hands out no sessions.
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_by_user ON sessions(user_id);

CREATE TABLE saves (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- The game's progress snapshot (JSON object), capped like the old player_saves table.
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot) AND length(snapshot) <= 131072),
  -- Bumped on every write; a write naming an old revision is refused (no lost updates).
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at INTEGER NOT NULL
);
