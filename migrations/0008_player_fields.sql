-- Fields someone mapped onto a path in a player's NBT (a mod's mana, a quest
-- counter), shown in the player editor for every player of the server.
-- path is a JSON array of compound keys and list indices; kind is how the
-- input shows it: number, checkbox or text.
CREATE TABLE player_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  instance_id TEXT NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX player_fields_instance_idx ON player_fields (instance_id);
