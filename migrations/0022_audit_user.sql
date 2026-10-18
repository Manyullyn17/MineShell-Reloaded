-- downgrade: safe
-- Who did it (requestcontext.ts): the account, and its name at the time, so
-- the entry still reads right after the account is renamed or deleted (no
-- foreign key: the log outlives accounts). Null: MineShell itself (scheduler,
-- recovery) or MINESHELL_AUTH=off.
ALTER TABLE audit_log ADD COLUMN user_id TEXT;
ALTER TABLE audit_log ADD COLUMN username TEXT;
