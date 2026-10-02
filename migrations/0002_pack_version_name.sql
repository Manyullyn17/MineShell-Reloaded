-- The pack version's human-readable label (e.g. "1.0.1" or "Meatballcraft-0.18.6.4"),
-- alongside the provider id kept in pack_version_id.
ALTER TABLE server_instances ADD COLUMN pack_version_name TEXT;
