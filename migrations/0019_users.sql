-- downgrade: unsafe - moves the admin password into users; an older MineShell finds none and cannot sign anyone in
-- Accounts (auth.ts). One is the owner: it cannot be deleted, demoted or
-- disabled, which the triggers enforce below the app too. Its id, not its
-- name, is what identifies it.
CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_owner INTEGER NOT NULL DEFAULT 0,
  disabled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX users_username_idx ON users (lower(username));
CREATE UNIQUE INDEX users_one_owner_idx ON users (is_owner) WHERE is_owner = 1;

CREATE TRIGGER users_owner_not_deleted BEFORE DELETE ON users WHEN OLD.is_owner = 1
BEGIN
  SELECT RAISE(ABORT, 'The owner account cannot be deleted.');
END;
CREATE TRIGGER users_owner_kept BEFORE UPDATE OF is_owner, disabled_at ON users
WHEN OLD.is_owner = 1 AND (NEW.is_owner = 0 OR NEW.disabled_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'The owner account cannot be demoted or disabled.');
END;

-- The one admin password becomes the owner, named "admin".
INSERT INTO users (id, username, password_hash, is_owner, created_at, updated_at)
  SELECT lower(hex(randomblob(16))), 'admin', value, 1,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM settings WHERE key = 'auth.password_hash';
DELETE FROM settings WHERE key = 'auth.password_hash';

-- Sessions belong to an account; the ones open now are the owner's, so
-- nobody is signed out by the update.
ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
UPDATE sessions SET user_id = (SELECT id FROM users WHERE is_owner = 1);
DELETE FROM sessions WHERE user_id IS NULL;
CREATE INDEX sessions_user_idx ON sessions (user_id);
