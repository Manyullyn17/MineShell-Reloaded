-- What accounts other than the owner may do (access.ts). Global admin and
-- "may create servers" are flags on the account; everything per server is a
-- row in instance_access. An instance admin is a flag on that row, kept apart
-- from the listed permissions, so taking admin away leaves the list as it was.
ALTER TABLE users ADD COLUMN is_global_admin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN can_create INTEGER NOT NULL DEFAULT 0;

CREATE TABLE instance_access (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  is_admin INTEGER NOT NULL DEFAULT 0,
  -- JSON array of permission ids (lib/shared/access.ts); unknown ones are ignored on read.
  permissions TEXT NOT NULL DEFAULT '[]',
  -- Player data: none, all (players who join later too), or selected (instance_player_access).
  player_view TEXT NOT NULL DEFAULT 'none' CHECK (player_view IN ('none', 'all', 'selected')),
  player_edit TEXT NOT NULL DEFAULT 'none' CHECK (player_edit IN ('none', 'all', 'selected')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, instance_id)
);
CREATE INDEX instance_access_instance_idx ON instance_access (instance_id);

-- The players a "selected" scope covers, by UUID (lower case, with dashes).
CREATE TABLE instance_player_access (
  user_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  uuid TEXT NOT NULL CHECK (uuid = lower(uuid) AND length(uuid) = 36),
  can_edit INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, instance_id, uuid),
  FOREIGN KEY (user_id, instance_id) REFERENCES instance_access (user_id, instance_id) ON DELETE CASCADE
);
