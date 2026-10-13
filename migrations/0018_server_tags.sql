CREATE TABLE server_tags (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL
);
CREATE UNIQUE INDEX server_tags_name_idx ON server_tags (lower(name));

CREATE TABLE instance_tags (
  instance_id TEXT NOT NULL REFERENCES server_instances(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES server_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (instance_id, tag_id)
);
CREATE INDEX instance_tags_tag_idx ON instance_tags (tag_id);
