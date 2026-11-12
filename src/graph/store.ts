import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeId } from "../core/types.js";
import type { GraphNode, GraphEdge, EdgeKind } from "../core/types.js";
import type { ImportRef } from "../parse/extract.js";
import { resolveModulePath } from "../resolution/module_path.js";
import { compactVariants, expandMorphology } from "../semantic/morph.js";

const SCHEMA = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8");

/**
 * Created on first cache use as well as by the schema, so a DB written by an
 * older rinnegan grows the table lazily instead of failing to cache.
 */
const CACHE_SCHEMA = `CREATE TABLE IF NOT EXISTS semantic_cache (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  fingerprint TEXT NOT NULL,
  payload     BLOB NOT NULL
)`;

/**
 * Deterministic per-file token cap for files_fts. Bodies are indexed up to this
 * many tokens (in file order) so the prior is bounded work regardless of file
 * size and identical across runs of the same bytes.
 */
const FILE_TOKEN_CAP = 4096;

/**
 * How much more a files_fts PATH token counts than a body token. A path is a
 * deliberate, low-noise statement of what a file is for ("promql/engine.go",
 * "action_dispatch/routing/route_set.rb"); a body repeats common words and is
 * length-normalized by BM25, so a long implementation file loses to a short
 * document that merely mentions the same words. Weighting the path 6:1 restores
 * the intent signal. Passed positionally to bm25() in column order
 * (file UNINDEXED, path_tokens, tokens).
 */
const FILE_PATH_WEIGHT = 6;

/**
 * Target size, in body tokens, of one indexed BODY WINDOW — the unit the file
 * prior is scored in. BM25 length-normalizes long documents down, so a 50k-token
 * implementation file loses to a 200-token helper on the same evidence; a ~512
 * token chunk is about one method plus its neighbours, which is the granularity
 * at which "does this file contain the thing the task asks about" is a fair
 * question.
 */
export const WINDOW_TOKENS = 512;

/**
 * Hard ceiling on the windows one file may contribute. Bodies are tiled
 * contiguously into at most this many chunks, so the indexed work per file stays
 * bounded (≤ WINDOW_MAX × max(WINDOW_TOKENS, file/ WINDOW_MAX) tokens) while
 * every source line still falls inside exactly one window — a symbol's own range
 * can always join a chunk, which is what `windowRelevance` relies on. Files
 * shorter than WINDOW_MAX × WINDOW_TOKENS get true WINDOW_TOKENS-sized chunks;
 * longer files get proportionally larger ones instead of an unbounded row count.
 */
export const WINDOW_MAX = 16;

/**
 * Version of the file-prior token recipe (path tokens + identifier morphology +
 * body windows). Bumping it makes `index` rebuild every file's token rows ONCE
 * from the file's bytes — no reparse. Stored per file in `files.fts_version`, so
 * the backfill is a cheap presence check on later runs.
 */
export const FILE_FTS_VERSION = 2;

export interface FileMeta {
  hash: string;
  mtimeMs: number;
  nodeIds: string[];
  role: string;
  /** ANALYZER_VERSION that produced this file's nodes/edges — see parse/extract.ts. */
  analyzerVersion: number;
  /** FILE_FTS_VERSION that produced this file's files_fts row. */
  ftsVersion: number;
}

export interface OpenOpts {
  /** Open an existing DB without write access — queries work, caches are not written. */
  readonly?: boolean;
}

/** Lowercase tokens from an identifier-ish string: camelCase + snake + dots split. */
export function basicTokens(s: string): string[] {
  if (!s) return [];
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/\\:#-]+/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * Index-time token stream for a short piece of identifier text (a symbol's name
 * + signature + docstring, or a file path): document order, term frequency
 * preserved, plus morphological variants and compound ("PromQL" → "promql")
 * forms. Deterministic — the same text always yields the same stream.
 */
function documentTokens(text: string): string[] {
  return [...expandMorphology(basicTokens(text)), ...compactVariants(text)];
}

/**
 * Query-side FTS terms for `text`: the same expansion as the index side, but
 * deduplicated (a MATCH only needs the distinct terms). Empty when the text has
 * no usable token, so callers can treat "nothing to match" as a no-op.
 */
export function ftsQueryTerms(text: string): string[] {
  return [...new Set([...expandMorphology(basicTokens(text)), ...compactVariants(text)])];
}

/** One indexed body window: absolute 1-based source lines, pre-expanded tokens. */
export interface BodyWindow {
  startLine: number;
  endLine: number;
  tokens: string[];
}

/**
 * Cut a file's body into the BM25 documents the file prior scores.
 *
 * Deterministic tiling, not a sliding window: the file is split into
 * `n = ceil(total / size)` contiguous chunks of `size = max(WINDOW_TOKENS,
 * ceil(total / WINDOW_MAX))` body tokens, where a token is one `basicTokens`
 * element of a line. Consequences, all load-bearing:
 *
 *  - **Full, exclusive coverage.** The windows are a partition of the file's
 *    lines, so every line falls inside exactly one window, a symbol's
 *    `startLine..endLine` always overlaps a chunk (and `windowRelevance` never
 *    has to fall back to reading the file), and no token is counted twice. An
 *    overlapping stride would index ~1.33× the rows for a symbol that straddles
 *    a boundary, which the intersection test already handles.
 *  - **Bounded work.** `n ≤ WINDOW_MAX`; short files stay at WINDOW_TOKENS and a
 *    long one trades chunk count for chunk size instead of growing unboundedly.
 *  - **Line alignment.** Spans are widened to whole lines, so `start_line` /
 *    `end_line` are exact source coordinates and two runs over the same bytes
 *    produce byte-identical windows.
 *
 * Tokens are morphology-expanded exactly like the whole-file row, in file order,
 * so term frequency survives inside the chunk.
 */
export function bodyWindows(content: string): BodyWindow[] {
  if (!content) return [];
  const lines = content.split("\n");
  const perLine = lines.map((l) => basicTokens(l));
  const cum = new Array<number>(perLine.length + 1);
  cum[0] = 0;
  for (let i = 0; i < perLine.length; i++) cum[i + 1] = cum[i] + perLine[i].length;
  const total = cum[perLine.length];
  if (total === 0) return [];

  const size = Math.max(WINDOW_TOKENS, Math.ceil(total / WINDOW_MAX));
  // 1-based line holding token `t` (0-based): the last line whose start offset is ≤ t.
  const lineOf = (t: number): number => {
    let lo = 0;
    let hi = perLine.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cum[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const out: BodyWindow[] = [];
  for (let start = 0; start < total; start += size) {
    const end = Math.min(total, start + size);
    // Widen the token span to whole lines, then trim to the lines the previous
    // window did not already claim: a long line can straddle a boundary, and the
    // windows are a partition of the file's lines (each line in exactly one
    // window) so no token is counted twice.
    const prev = out[out.length - 1];
    const from = prev ? Math.max(lineOf(start), prev.endLine + 1) : lineOf(start);
    const endLine = lineOf(end - 1);
    if (from > endLine) continue;
    const tokens: string[] = [];
    for (let i = from; i <= endLine; i++) tokens.push(...perLine[i - 1]);
    out.push({ startLine: from, endLine, tokens: expandMorphology(tokens) });
  }
  return out;
}

interface NodeRow {
  id: string; kind: string; qualified_name: string; file_path: string;
  language: string; start_line: number; end_line: number;
  signature: string | null; docstring: string | null; is_exported: number;
}
interface EdgeRow {
  source: string; target: string; kind: string; line: number; col: number;
  provenance: string; confidence: number; resolver: string;
  read_write: string | null; metadata: string | null;
}

/**
 * SQLite-backed provenance graph store (WAL + FTS5), the durable knowledge base
 * for a codebase — the codegraph approach, not a flat dump.
 */
export class GraphStore {
  private db: Database.Database;
  private stmtCache = new Map<string, Database.Statement>();

  private constructor(dbPath: string, opts: OpenOpts = {}) {
    const readonly = !!opts.readonly;
    if (dbPath !== ":memory:" && !readonly) mkdirSync(dirname(dbPath), { recursive: true });
    this.db = readonly ? new Database(dbPath, { readonly: true, fileMustExist: true }) : new Database(dbPath);
    // A read-only connection must not attempt any DDL: schema + migrations are
    // skipped, and readers tolerate a DB that predates a table (cache misses).
    if (readonly) return;
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);

    // Additive migrations: old DBs predate these columns. analyzer_version
    // defaults to 0 so pre-existing rows read as stale and reparse on next sync.
    const cols = (this.db.pragma("table_info(files)") as { name: string }[]).map((c) => c.name);
    if (!cols.includes("role")) this.db.exec(`ALTER TABLE files ADD COLUMN role TEXT NOT NULL DEFAULT 'library'`);
    if (!cols.includes("analyzer_version")) this.db.exec(`ALTER TABLE files ADD COLUMN analyzer_version INTEGER NOT NULL DEFAULT 0`);
    if (!cols.includes("fts_version")) this.db.exec(`ALTER TABLE files ADD COLUMN fts_version INTEGER NOT NULL DEFAULT 0`);

    // files_fts gained the weighted `path_tokens` column. FTS5 tables cannot add
    // a column, so an older one is dropped and recreated; every file is stamped
    // as needing its token row rebuilt (fts_version = 0) and Indexer backfills
    // those rows from the file bytes on the next `index` — no reparse required.
    const ftsCols = (this.db.pragma("table_info(files_fts)") as { name: string }[]).map((c) => c.name);
    if (!ftsCols.includes("path_tokens")) {
      this.db.exec(`DROP TABLE IF EXISTS files_fts`);
      this.db.exec(`CREATE VIRTUAL TABLE files_fts USING fts5(file UNINDEXED, path_tokens, tokens)`);
      this.db.exec(`UPDATE files SET fts_version = 0`);
    }
  }

  /** Memoized prepared statement — compile each SQL once, reuse for every call. */
  private stmt(sql: string): Database.Statement {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  static open(dbPath: string, opts: OpenOpts = {}): GraphStore {
    return new GraphStore(dbPath, opts);
  }

  /** True when opened without write access (queries work; caches are not written). */
  isReadOnly(): boolean {
    return this.db.readonly;
  }

  /**
   * Read the persisted semantic model for this exact corpus key, or `undefined`
   * on any miss: no row, a different key, a DB that predates the table, or a
   * payload the caller rejects. Never a partial or stale model.
   */
  readSemanticCache(key: string): Buffer | undefined {
    try {
      const row = this.stmt(`SELECT fingerprint, payload FROM semantic_cache WHERE id = 1`).get() as
        | { fingerprint: string; payload: Buffer }
        | undefined;
      if (!row || row.fingerprint !== key) return undefined;
      return row.payload;
    } catch {
      return undefined; // no semantic_cache table (pre-cache DB) or unreadable row
    }
  }

  /** Persist the semantic model. Best effort: a read-only DB/file just skips it. */
  writeSemanticCache(key: string, payload: Buffer): boolean {
    if (this.db.readonly) return false;
    try {
      this.db.exec(CACHE_SCHEMA);
      this.stmt(`INSERT OR REPLACE INTO semantic_cache (id, fingerprint, payload) VALUES (1, ?, ?)`).run(key, payload);
      return true;
    } catch {
      return false; // e.g. a read-only filesystem — the cache is an optimization, never a failure
    }
  }

  deleteSemanticCache(): void {
    try {
      this.stmt(`DELETE FROM semantic_cache WHERE id = 1`).run();
    } catch {
      // table absent — nothing to drop
    }
  }

  private rowToNode(r: NodeRow): GraphNode {
    return {
      id: r.id, kind: r.kind as GraphNode["kind"], qualifiedName: r.qualified_name,
      filePath: r.file_path, language: r.language, startLine: r.start_line, endLine: r.end_line,
      signature: r.signature ?? undefined, docstring: r.docstring ?? undefined,
      isExported: !!r.is_exported,
    };
  }
  private rowToEdge(r: EdgeRow): GraphEdge {
    return {
      source: r.source, target: r.target, kind: r.kind as EdgeKind, line: r.line, col: r.col,
      provenance: r.provenance as GraphEdge["provenance"], confidence: r.confidence,
      resolver: r.resolver, readWrite: (r.read_write ?? undefined) as GraphEdge["readWrite"],
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    };
  }

  insertNode(n: GraphNode): void {
    this.stmt(
      `INSERT OR REPLACE INTO nodes
       (id,kind,qualified_name,file_path,language,start_line,end_line,signature,docstring,is_exported)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(n.id, n.kind, n.qualifiedName, n.filePath, n.language, n.startLine, n.endLine,
      n.signature ?? null, n.docstring ?? null, n.isExported ? 1 : 0);

    const tokens = documentTokens(`${n.qualifiedName} ${n.signature ?? ""} ${n.docstring ?? ""}`).join(" ");
    // Key FTS rows by the node's rowid. `id UNINDEXED` cannot be deleted by key;
    // every such delete would full-scan nodes_fts (quadratic indexing).
    const row = this.stmt(`SELECT rowid AS rid FROM nodes WHERE id = ?`).get(n.id) as { rid: number };
    this.stmt(`DELETE FROM nodes_fts WHERE rowid = ?`).run(row.rid);
    this.stmt(`INSERT INTO nodes_fts (rowid, id, tokens) VALUES (?, ?, ?)`).run(row.rid, n.id, tokens);
  }

  insertEdge(e: GraphEdge): void {
    this.stmt(
      `INSERT INTO edges (source,target,kind,line,col,provenance,confidence,resolver,read_write,metadata)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(e.source, e.target, e.kind, e.line, e.col, e.provenance, e.confidence, e.resolver,
      e.readWrite ?? null, e.metadata ? JSON.stringify(e.metadata) : null);
  }

  getNode(id: string): GraphNode | undefined {
    const r = this.stmt(`SELECT * FROM nodes WHERE id = ?`).get(id) as NodeRow | undefined;
    return r ? this.rowToNode(r) : undefined;
  }

  outgoing(id: string, kinds?: EdgeKind[]): GraphEdge[] {
    const rows = this.stmt(
      `SELECT * FROM edges WHERE source = ? ORDER BY target, kind, line`,
    ).all(id) as EdgeRow[];
    const edges = rows.map((r) => this.rowToEdge(r));
    return kinds ? edges.filter((e) => kinds.includes(e.kind)) : edges;
  }

  incoming(id: string, kinds?: EdgeKind[]): GraphEdge[] {
    const rows = this.stmt(
      `SELECT * FROM edges WHERE target = ? ORDER BY source, kind, line`,
    ).all(id) as EdgeRow[];
    const edges = rows.map((r) => this.rowToEdge(r));
    return kinds ? edges.filter((e) => kinds.includes(e.kind)) : edges;
  }

  /** FTS5 BM25 search over pre-tokenized identifier text. Deterministic id tie-break. */
  searchFts(query: string, limit: number): GraphNode[] {
    const toks = ftsQueryTerms(query);
    if (toks.length === 0) return [];
    const match = toks.map((t) => `"${t}"`).join(" OR ");
    const rows = this.stmt(
      `SELECT n.* FROM nodes_fts f JOIN nodes n ON n.id = f.id
       WHERE f.tokens MATCH ? ORDER BY bm25(nodes_fts), n.id LIMIT ?`,
    ).all(match, limit) as NodeRow[];
    return rows.map((r) => this.rowToNode(r));
  }

  /**
   * Substring fallback over the FTS token text: finds symbols whose token text
   * CONTAINS a fragment — query "vnc" reaches `novnc`, `vncTicket`. FTS MATCH
   * is whole-token only, so without this those symbols are invisible. LIKE on
   * the fts column is a scan; bounded by LIMIT. Deterministic id tie-break.
   */
  searchTokensSubstring(fragments: string[], limit: number): GraphNode[] {
    const frags = [...new Set(fragments)]
      .map((f) => f.toLowerCase().replace(/[%_]/g, ""))
      .filter((f) => f.length >= 3);
    if (frags.length === 0 || limit <= 0) return [];
    const where = frags.map(() => `f.tokens LIKE ?`).join(" OR ");
    const rows = this.stmt(
      `SELECT n.* FROM nodes_fts f JOIN nodes n ON n.id = f.id
       WHERE ${where} ORDER BY n.id LIMIT ?`,
    ).all(...frags.map((f) => `%${f}%`), limit) as NodeRow[];
    return rows.map((r) => this.rowToNode(r));
  }

  /** BM25 score per node id for a query (lower bm25 = better; we return -bm25 as score). */
  bm25Scores(query: string, limit: number): { id: string; score: number }[] {
    const toks = ftsQueryTerms(query);
    if (toks.length === 0) return [];
    const match = toks.map((t) => `"${t}"`).join(" OR ");
    const rows = this.stmt(
      `SELECT f.id AS id, bm25(nodes_fts) AS b FROM nodes_fts f
       WHERE f.tokens MATCH ? ORDER BY b, f.id LIMIT ?`,
    ).all(match, limit) as { id: string; b: number }[];
    return rows.map((r) => ({ id: r.id, score: -r.b }));
  }

  /**
   * Store the index-time token text of a file for files_fts AND files_windows.
   * Deterministic: the PATH is tokenized (weighted, see FILE_PATH_WEIGHT) and the
   * BODY is `bodyWindows(content)` — contiguous ~WINDOW_TOKENS chunks, morpholo-
   * gy-expanded, absolute line ranges. Both row sets are replaced together, so a
   * rewrite can never leave a stale window behind.
   *
   * The whole-file row is still written because it is the fallback prior for a
   * database whose windows have not been backfilled (see fileRelevance) and
   * because `index` must keep working against an older reader. Its body stays
   * capped at FILE_TOKEN_CAP — the window rows are what reach past that cap, at a
   * bounded ~2× the tokens (16 × 512 for a short file, the same total for a long
   * one, never more than the file's own body).
   *
   * An empty document (no path and no usable body tokens) drops the row instead
   * of inserting one, so BM25 never sees a zero-length file; a file with a path
   * but no token-y body still gets one path-only window so its path prior
   * survives.
   *
   * Deletes key on the plain table's rowid (`file` is UNINDEXED in the fts table,
   * so `DELETE ... WHERE file = ?` would scan it) — the same trap `nodes_fts`
   * avoided by keying on rowid.
   */
  setFileTokens(filePath: string, content: string): void {
    if (this.db.readonly) return;
    const pathTokens = [...new Set([...basicTokens(filePath), ...compactVariants(filePath)])].join(" ");
    const bodyTokens = expandMorphology(basicTokens(content).slice(0, FILE_TOKEN_CAP)).join(" ");
    let windows = bodyWindows(content);
    if (windows.length === 0 && (pathTokens || bodyTokens)) {
      // No token-y body (empty file, punctuation only): one path-only window keeps
      // "the PATH names this concept" working without inventing body evidence.
      windows = [{ startLine: 1, endLine: Math.max(1, content.split("\n").length), tokens: [] }];
    }
    const write = this.db.transaction(() => {
      this.stmt(`DELETE FROM files_windows_fts WHERE rowid IN (SELECT id FROM files_windows WHERE file = ?)`).run(filePath);
      this.stmt(`DELETE FROM files_windows WHERE file = ?`).run(filePath);
      this.stmt(`DELETE FROM files_fts WHERE file = ?`).run(filePath);
      if (pathTokens || bodyTokens) {
        this.stmt(`INSERT INTO files_fts (file, path_tokens, tokens) VALUES (?, ?, ?)`).run(filePath, pathTokens, bodyTokens);
      }
      const insMeta = this.stmt(
        `INSERT INTO files_windows (file, start_line, end_line, token_count) VALUES (?, ?, ?, ?)`,
      );
      const insFts = this.stmt(
        `INSERT INTO files_windows_fts (rowid, file, path_tokens, tokens) VALUES (?, ?, ?, ?)`,
      );
      for (const w of windows) {
        const tokens = w.tokens.join(" ");
        if (!pathTokens && !tokens) continue;
        const id = Number(insMeta.run(filePath, w.startLine, w.endLine, w.tokens.length).lastInsertRowid);
        insFts.run(id, filePath, pathTokens, tokens);
      }
    });
    write();
  }

  /**
   * Window scores for a query: one row per matching body window, best first.
   * `pathWeight` is the bm25 weight of the per-window PATH column — the file
   * prior wants FILE_PATH_WEIGHT (a window is a fair document, so the path no
   * longer gets diluted by the file's total length); the per-symbol prior passes
   * 0 so it measures the chunk's own body and never re-counts the file prior.
   *
   * Raw (un-normalized, positive-is-better) on purpose: the two callers
   * normalize over their own pools. Deterministic order: score DESC, then file
   * and start line. An absent table (a DB predating the window index) is an empty
   * result, never a throw.
   */
  windowScores(
    query: string,
    limit: number,
    pathWeight = FILE_PATH_WEIGHT,
  ): { file: string; startLine: number; endLine: number; score: number }[] {
    const toks = ftsQueryTerms(query);
    if (toks.length === 0 || limit <= 0) return [];
    const match = toks.map((t) => `"${t}"`).join(" OR ");
    let rows: { file: string; s: number; e: number; b: number }[];
    try {
      rows = this.stmt(
        `SELECT w.file AS file, w.start_line AS s, w.end_line AS e,
                bm25(files_windows_fts, 0.0, ${pathWeight}, 1.0) AS b
         FROM files_windows_fts f JOIN files_windows w ON w.id = f.rowid
         WHERE files_windows_fts MATCH ?
         ORDER BY b, w.file, w.start_line LIMIT ?`,
      ).all(match, limit) as { file: string; s: number; e: number; b: number }[];
    } catch {
      return []; // no files_windows_fts (old DB) — no window evidence
    }
    return rows
      .map((r) => ({ file: r.file, startLine: r.s, endLine: r.e, score: -r.b }))
      .filter((r) => r.score > 0);
  }

  /**
   * File-level relevance prior: the strongest evidence ANY view of the file has
   * for the task, normalized so the best file is 1 and the rest sit in 0..1.
   *
   * Two views, because "does this file contain the thing the task asks about"
   * fails differently in each:
   *
   *  - **Best window** (`files_windows`, path weighted 6:1 inside each chunk).
   *    BM25 divides every term's contribution by the document's length relative
   *    to the average, so a 50k-token implementation file is penalized for being
   *    long even when the exact chunk the task is about sits inside it, and a
   *    30-line helper that repeats two query words wins. Each window is a
   *    ~512-token document — one method and its neighbours — so
   *    `max over windows of bm25(files_windows_fts, 0, 6, 1)` ranks the file by
   *    its BEST evidence. The path column keeps its weight inside every window,
   *    so "the path names the concept" still wins on its own.
   *  - **Whole file** (`files_fts`): the pre-window formula, unchanged. It is
   *    better exactly when the evidence is DIFFUSE — a file that says the right
   *    thing once per section (tokio's `io/poll_evented.rs`, prometheus's
   *    `scrape/manager.go`) accumulates across its whole body under one document
   *    and loses if only its single best chunk counts.
   *
   * The prior is `max(normalized window, normalized whole)` — a maximum, so it
   * is monotone non-decreasing in both views: a file that was strong under the
   * old formula can never be diluted by the new one, and a file whose evidence
   * is concentrated gets the rank its best chunk earns. Both views are 0..1 with
   * the best file at 1, so the combined map is too (a tie at 1 is broken by path,
   * deterministically).
   *
   * Falls back to the whole-file view alone when the window table is absent or
   * empty (a DB written before the window index, or a read-only open
   * mid-migration). A missing prior must be a no-op, never a failed query.
   */
  fileRelevance(query: string, limit = 200): Map<string, number> {
    const toks = ftsQueryTerms(query);
    if (toks.length === 0) return new Map();
    const whole = this.fileRelevanceWholeFile(toks, limit);
    // Enough window rows to be certain the best window of each of the `limit`
    // best files is present: a file contributes at most WINDOW_MAX rows.
    const windows = this.windowScores(query, Math.max(limit * WINDOW_MAX, WINDOW_MAX));
    if (windows.length === 0) return whole;
    const best = new Map<string, number>();
    for (const w of windows) {
      const cur = best.get(w.file);
      if (cur === undefined || w.score > cur) best.set(w.file, w.score);
    }
    let max = 0;
    for (const s of best.values()) max = Math.max(max, s);
    if (max <= 0) return whole;
    const out = new Map<string, number>();
    for (const file of [...best.keys()].sort()) out.set(file, best.get(file)! / max);
    for (const [file, score] of whole) out.set(file, Math.max(score, out.get(file) ?? 0));
    return out;
  }

  /**
   * The pre-window prior: BM25 over one document per file (path column weighted
   * FILE_PATH_WEIGHT, body capped at FILE_TOKEN_CAP), normalized to 0..1. Kept
   * verbatim as fileRelevance's fallback so an index without window rows (older
   * DB, read-only open before backfill) behaves exactly as it did before.
   */
  private fileRelevanceWholeFile(toks: string[], limit: number): Map<string, number> {
    const match = toks.map((t) => `"${t}"`).join(" OR ");
    let rows: { file: string; b: number }[];
    try {
      rows = this.stmt(
        `SELECT file, bm25(files_fts, 0.0, ${FILE_PATH_WEIGHT}, 1.0) AS b FROM files_fts
         WHERE files_fts MATCH ? ORDER BY b, file LIMIT ?`,
      ).all(match, limit) as { file: string; b: number }[];
    } catch {
      return new Map(); // no files_fts / no path_tokens column (old DB) — no prior available
    }
    const scored = rows.map((r) => ({ file: r.file, score: -r.b }));
    let max = 0;
    for (const s of scored) max = Math.max(max, s.score);
    if (max <= 0) return new Map();
    return new Map(scored.map((s) => [s.file, s.score / max]));
  }

  allNodes(): GraphNode[] {
    return (this.stmt(`SELECT * FROM nodes ORDER BY id`).all() as NodeRow[]).map((r) => this.rowToNode(r));
  }

  /** Every node declared in a file, in source order. Deterministic. */
  nodesInFile(path: string): GraphNode[] {
    return (this.stmt(`SELECT * FROM nodes WHERE file_path = ? ORDER BY start_line, id`).all(path) as NodeRow[])
      .map((r) => this.rowToNode(r));
  }

  allEdges(): GraphEdge[] {
    return (this.stmt(`SELECT * FROM edges ORDER BY source,target,kind,line`).all() as EdgeRow[])
      .map((r) => this.rowToEdge(r));
  }

  // --- imports (for cross-file resolution) ---
  setImports(file: string, refs: ImportRef[]): void {
    this.stmt(`DELETE FROM imports WHERE file = ?`).run(file);
    const ins = this.stmt(
      `INSERT INTO imports (file,local_name,imported_name,module_spec,line) VALUES (?,?,?,?,?)`,
    );
    for (const r of refs) ins.run(file, r.localName, r.importedName, r.moduleSpec, r.line);
  }

  getImports(file: string): ImportRef[] {
    const rows = this.stmt(`SELECT * FROM imports WHERE file = ?`).all(file) as {
      local_name: string; imported_name: string; module_spec: string; line: number;
    }[];
    return rows.map((r) => ({ localName: r.local_name, importedName: r.imported_name, moduleSpec: r.module_spec, line: r.line }));
  }

  fileExists(path: string): boolean {
    return !!this.stmt(`SELECT 1 FROM files WHERE path = ?`).get(path);
  }

  /** Find an exported top-level symbol by name in a given file. */
  findExportedNode(filePath: string, name: string): GraphNode | undefined {
    const r = this.stmt(
      `SELECT * FROM nodes WHERE file_path = ? AND is_exported = 1 AND qualified_name = ? LIMIT 1`,
    ).get(filePath, name) as NodeRow | undefined;
    return r ? this.rowToNode(r) : undefined;
  }

  deleteEdge(e: GraphEdge): void {
    this.stmt(
      `DELETE FROM edges WHERE source=? AND target=? AND kind=? AND line=? AND col=?`,
    ).run(e.source, e.target, e.kind, e.line, e.col);
  }

  getFileMeta(path: string): FileMeta | undefined {
    const r = this.stmt(`SELECT * FROM files WHERE path = ?`).get(path) as
      | { path: string; hash: string; mtime_ms: number; node_ids: string; role: string | null; analyzer_version: number; fts_version: number }
      | undefined;
    return r
      ? {
          hash: r.hash,
          mtimeMs: r.mtime_ms,
          nodeIds: JSON.parse(r.node_ids),
          role: r.role ?? "library",
          analyzerVersion: r.analyzer_version,
          ftsVersion: r.fts_version ?? 0,
        }
      : undefined;
  }

  setFileMeta(path: string, meta: FileMeta): void {
    this.stmt(
      `INSERT OR REPLACE INTO files (path,hash,mtime_ms,node_ids,role,analyzer_version,fts_version) VALUES (?,?,?,?,?,?,?)`,
    ).run(path, meta.hash, meta.mtimeMs, JSON.stringify(meta.nodeIds), meta.role, meta.analyzerVersion, meta.ftsVersion);
  }

  /** Role per indexed file path, sorted by path. */
  roleByFile(): Map<string, string> {
    const rows = this.stmt(`SELECT path, role FROM files ORDER BY path`).all() as { path: string; role: string }[];
    return new Map(rows.map((r) => [r.path, r.role]));
  }

  /**
   * Remove all nodes/edges that originated from a file (for re-index).
   *
   * A naive "delete every edge touching this file's node ids" also destroys
   * INBOUND edges from other files — e.g. B's already-resolved `calls` edge
   * into A's `charge()` — with nothing to recreate them: resolveImports only
   * rewrites edges that are still `provenance: "unresolved"`, and B itself
   * isn't being reparsed, so B's call knowledge would be lost until B is
   * touched. Instead, edges whose target is in this file but whose source is
   * NOT get downgraded back to the pre-resolution unresolved boundary the
   * extractor would have emitted, so the next `resolveImports` pass (every
   * caller of removeFile runs one) re-resolves it once A's replacement nodes
   * land, or leaves an honest unresolved boundary if the symbol is gone.
   *
   * Scoped to `kind === "calls"` — the only edge kind resolveImports ever
   * promotes cross-file, so it's the only kind safe to reconstruct this way.
   * Other cross-file inbound edges (e.g. a manifest's shared package-hub node,
   * whose kind is "references") fall through to the plain delete below,
   * unchanged from prior behavior — synthesizing an "unresolved" placeholder
   * for those would be dishonest, not a fix.
   */
  removeFile(path: string): void {
    const meta = this.getFileMeta(path);
    if (!meta) return;
    const removedIds = new Set(meta.nodeIds);

    // For attributing a downgraded `default`-import placeholder: mirrors
    // resolveImports's own default heuristic (a file with exactly one
    // exported symbol — that symbol is "the" default), computed once here
    // against the file being removed.
    const exportedInFile = meta.nodeIds
      .map((id) => this.getNode(id))
      .filter((n): n is GraphNode => !!n && !!n.isExported);

    interface Downgrade {
      source: string; line: number; col: number; readWrite: GraphEdge["readWrite"];
      name: string; sourceFile: string; language: string;
    }
    const downgrades: Downgrade[] = [];
    const importsByCallerFile = new Map<string, ImportRef[]>();
    for (const id of meta.nodeIds) {
      const tgt = this.getNode(id);
      if (!tgt) continue;
      for (const e of this.incoming(id, ["calls"])) {
        if (removedIds.has(e.source)) continue; // same-file — handled by the bulk delete below
        const src = this.getNode(e.source);
        if (!src) continue;

        // Name the placeholder from the CALLER's import row, not the
        // target's declared name — resolveImports re-resolves by matching
        // the caller's import *localName* (imports.ts:59-60). An aliased
        // (`import { charge as doCharge }`) or default import under a
        // different local name would otherwise never re-match, permanently
        // stranding the edge as unresolved.
        let imports = importsByCallerFile.get(src.filePath);
        if (!imports) importsByCallerFile.set(src.filePath, (imports = this.getImports(src.filePath)));
        const imp = imports.find(
          (i) =>
            resolveModulePath(src.filePath, i.moduleSpec, this) === path &&
            (i.importedName === tgt.qualifiedName ||
              (i.importedName === "default" && exportedInFile.length === 1 && exportedInFile[0].id === tgt.id)),
        );

        downgrades.push({
          source: e.source, line: e.line, col: e.col, readWrite: e.readWrite,
          name: imp ? imp.localName : tgt.qualifiedName, // fallback: no import row matched (e.g. same-language global heuristics)
          sourceFile: src.filePath, language: src.language,
        });
      }
    }

    const del = this.db.transaction(() => {
      for (const id of meta.nodeIds) {
        this.stmt(`DELETE FROM nodes_fts WHERE rowid = (SELECT rowid FROM nodes WHERE id = ?)`).run(id);
        this.stmt(`DELETE FROM nodes WHERE id = ?`).run(id);
        this.stmt(`DELETE FROM edges WHERE source = ? OR target = ?`).run(id, id);
      }
      this.stmt(`DELETE FROM files WHERE path = ?`).run(path);
      this.stmt(`DELETE FROM imports WHERE file = ?`).run(path);
      this.stmt(`DELETE FROM files_fts WHERE file = ?`).run(path);
      this.stmt(`DELETE FROM files_windows_fts WHERE rowid IN (SELECT id FROM files_windows WHERE file = ?)`).run(path);
      this.stmt(`DELETE FROM files_windows WHERE file = ?`).run(path);

      for (const d of downgrades) {
        const qn = `<unresolved>.${d.name}`;
        const placeholderId = nodeId(d.sourceFile, qn);
        // Same shape ensureUnresolved() in the extractors would emit — this
        // node id/shape must round-trip through resolveImports's own
        // `tgt.qualifiedName.replace(/^<unresolved>\./, "")` unwrap.
        this.insertNode({
          id: placeholderId, kind: "unresolved", qualifiedName: qn, filePath: d.sourceFile,
          language: d.language, startLine: d.line, endLine: d.line,
        });
        this.insertEdge({
          source: d.source, target: placeholderId, kind: "calls", line: d.line, col: d.col,
          provenance: "unresolved", confidence: 0, resolver: "downgraded", readWrite: d.readWrite,
          metadata: { boundary: "downgraded" },
        });
      }
    });
    del();
  }

  /** Atomic batch mutation via a real SQLite transaction. */
  tx<T>(fn: (store: GraphStore) => T): T {
    return this.db.transaction(() => fn(this))();
  }

  flush(): void {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }

  close(): void {
    this.db.close();
  }

  /** All indexed file paths, sorted. */
  allFilePaths(): string[] {
    return (this.stmt(`SELECT path FROM files ORDER BY path`).all() as { path: string }[]).map((r) => r.path);
  }

  stats(): { nodes: number; edges: number; files: number } {
    const n = (this.stmt(`SELECT count(*) c FROM nodes`).get() as { c: number }).c;
    const e = (this.stmt(`SELECT count(*) c FROM edges`).get() as { c: number }).c;
    const f = (this.stmt(`SELECT count(*) c FROM files`).get() as { c: number }).c;
    return { nodes: n, edges: e, files: f };
  }

  /** Corpus identity: same fingerprint ⇒ same index bytes (determinism promise). */
  fingerprint(): string {
    const h = createHash("sha256");
    // analyzer_version participates: same file bytes analyzed by a different
    // analyzer are a different index, so the fingerprint must differ too.
    const rows = this.stmt(`SELECT path, hash, analyzer_version FROM files ORDER BY path`).all() as { path: string; hash: string; analyzer_version: number }[];
    for (const r of rows) h.update(`${r.path}\0${r.hash}\0${r.analyzer_version}\n`);
    return h.digest("hex");
  }
}
