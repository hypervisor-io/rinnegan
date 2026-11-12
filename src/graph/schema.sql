-- Rinnegan provenance graph schema. The verifiability columns on `edges`
-- (provenance, confidence, resolver, read_write) are the heart of the design.

CREATE TABLE IF NOT EXISTS nodes (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  language      TEXT NOT NULL,
  start_line    INTEGER NOT NULL,
  end_line      INTEGER NOT NULL,
  signature     TEXT,
  docstring     TEXT,
  is_exported   INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS edges (
  source     TEXT NOT NULL,
  target     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  line       INTEGER NOT NULL,
  col        INTEGER NOT NULL,
  provenance TEXT NOT NULL,
  confidence REAL NOT NULL,
  resolver   TEXT NOT NULL,
  read_write TEXT,
  metadata   TEXT
);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);

CREATE TABLE IF NOT EXISTS files (
  path             TEXT PRIMARY KEY,
  hash             TEXT NOT NULL,
  mtime_ms         REAL NOT NULL,
  node_ids         TEXT NOT NULL,
  role             TEXT NOT NULL DEFAULT 'library',
  analyzer_version INTEGER NOT NULL DEFAULT 0,
  fts_version      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS imports (
  file         TEXT NOT NULL,
  local_name   TEXT NOT NULL,
  imported_name TEXT NOT NULL,
  module_spec  TEXT NOT NULL,
  line         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file);

-- FTS5 over pre-tokenized text (camelCase/snake already split into words),
-- so BM25 ranking sees identifier sub-tokens. `id` is carried UNINDEXED.
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(id UNINDEXED, tokens);

-- FTS5 over the PATH tokens and BODY text of each indexed file, pre-tokenized
-- like nodes_fts (see GraphStore.setFileTokens). `file` is carried UNINDEXED;
-- `path_tokens` is the weighted column (GraphStore.fileRelevance passes
-- bm25(files_fts, 0, 6, 1)), so a file whose PATH names the concept outranks a
-- short document that merely repeats the query's words. A file-level BM25 score
-- is the query-time prior that keeps a lexically-loud but unrelated file from
-- capturing an entire slice on symbol names alone.
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(file UNINDEXED, path_tokens, tokens);

-- Single-row cache for the semantic (LSA) model, which costs minutes to build on
-- a large corpus. `fingerprint` is the corpus identity (node count + the same
-- hash `rinnegan status` prints); a mismatch is a cache miss, never a stale hit.
-- The payload is a versioned deterministic binary blob — see semantic/cache.ts.
CREATE TABLE IF NOT EXISTS semantic_cache (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  fingerprint TEXT NOT NULL,
  payload     BLOB NOT NULL
);
