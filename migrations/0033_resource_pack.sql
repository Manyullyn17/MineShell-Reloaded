-- downgrade: safe
-- The server resource pack picked from a catalog (resourcepacks.ts), as JSON: where it came from,
-- the version and the URL players were given. Null for none, or one typed by hand.
ALTER TABLE server_instances ADD COLUMN resource_pack TEXT;
