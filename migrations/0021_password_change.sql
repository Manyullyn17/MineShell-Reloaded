-- downgrade: safe
-- Set on an account given a password by someone else (a new account, a
-- reset, scripts/reset-password.mjs): until it picks its own, the guard lets
-- it do nothing but that and signing out.
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
