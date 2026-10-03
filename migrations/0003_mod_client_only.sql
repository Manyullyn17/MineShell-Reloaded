-- Set when an installed jar is known not to belong on a dedicated server:
-- Modrinth's environment says client_only, the source flags the file, or the
-- jar declares a client environment. Per installed file, not per mod record:
-- manual mods share a record by file name, and a flag there would reach
-- unrelated jars that happen to share a name.
ALTER TABLE instance_mods ADD COLUMN client_only INTEGER NOT NULL DEFAULT 0;
