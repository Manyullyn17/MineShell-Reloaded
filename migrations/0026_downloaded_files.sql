-- Files MineShell downloaded with a known hash (filecache.ts): a later download
-- of the same content copies one of them instead, after checking its hash.
CREATE TABLE downloaded_files (
  path TEXT PRIMARY KEY NOT NULL,
  algo TEXT NOT NULL,
  hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL
);
CREATE INDEX downloaded_files_hash_idx ON downloaded_files (algo, hash);
