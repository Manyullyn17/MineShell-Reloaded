-- downgrade: safe
-- Quiet hours of a server's own notification destination (notifications.ts):
-- JSON { from, to }, null for none. MineShell's destination keeps them in its
-- settings value.
ALTER TABLE instance_notifications ADD COLUMN quiet TEXT;
