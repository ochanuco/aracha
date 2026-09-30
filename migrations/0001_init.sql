CREATE TABLE documents (
  document_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  type TEXT,
  title TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  content_blob_id TEXT,
  conflicted INTEGER NOT NULL DEFAULT 0,
  indexed_seq INTEGER NOT NULL
);

CREATE TABLE aliases (
  alias_path TEXT PRIMARY KEY,
  document_id TEXT NOT NULL
);
CREATE INDEX aliases_document ON aliases (document_id);

CREATE TABLE metadata (
  document_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  PRIMARY KEY (document_id, key)
);

CREATE TABLE edges (
  source_document_id TEXT NOT NULL,
  target_path TEXT NOT NULL,
  PRIMARY KEY (source_document_id, target_path)
);
CREATE INDEX edges_target ON edges (target_path);

CREATE VIRTUAL TABLE search USING fts5(document_id UNINDEXED, path, title, body, tokenize = 'trigram');

CREATE TABLE operation_index (
  operation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  document_id TEXT,
  detail_json TEXT,
  updated_at INTEGER NOT NULL
);
