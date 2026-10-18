-- downgrade: safe
-- A server's own notification destination, instead of or beside MineShell's
-- (notifications.ts). MineShell's own is a row in settings.
CREATE TABLE instance_notifications (
  instance_id TEXT PRIMARY KEY NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  url_enc TEXT NOT NULL,
  also_global INTEGER NOT NULL DEFAULT 0,
  kinds TEXT NOT NULL
);
