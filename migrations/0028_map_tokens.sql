-- downgrade: safe
-- The Map tab's frames (mapframe.ts): map content is served on a path of its
-- own with this token in it, sandboxed, since the map's pages are not
-- MineShell's. Gone with the session (signing out) or the server.
CREATE TABLE map_tokens (
  token TEXT PRIMARY KEY NOT NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  used_at INTEGER NOT NULL
);
CREATE INDEX map_tokens_session_idx ON map_tokens (session_id, instance_id);
