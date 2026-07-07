import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeId } from "../core/types.js";
import type { GraphNode, GraphEdge, EdgeKind } from "../core/types.js";
import type { ImportRef } from "../parse/extract.js";
import { resolveModulePath } from "../resolution/module_path.js";

const SCHEMA = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8");

export interface FileMeta {
  hash: string;
  mtimeMs: number;
  nodeIds: string[];
  role: string;
  /** ANALYZER_VERSION that produced this file's nodes/edges — see parse/extract.ts. */
  analyzerVersion: number;
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

  private constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);

    // Additive migrations: old DBs predate these columns. analyzer_version
    // defaults to 0 so pre-existing rows read as stale and reparse on next sync.
    const cols = (this.db.pragma("table_info(files)") as { name: string }[]).map((c) => c.name);
    if (!cols.includes("role")) this.db.exec(`ALTER TABLE files ADD COLUMN role TEXT NOT NULL DEFAULT 'library'`);
    if (!cols.includes("analyzer_version")) this.db.exec(`ALTER TABLE files ADD COLUMN analyzer_version INTEGER NOT NULL DEFAULT 0`);
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

  static open(dbPath: string): GraphStore {
    return new GraphStore(dbPath);
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

    const tokens = basicTokens(`${n.qualifiedName} ${n.signature ?? ""} ${n.docstring ?? ""}`).join(" ");
    this.stmt(`DELETE FROM nodes_fts WHERE id = ?`).run(n.id);
    this.stmt(`INSERT INTO nodes_fts (id, tokens) VALUES (?, ?)`).run(n.id, tokens);
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
    const toks = [...new Set(basicTokens(query))];
    if (toks.length === 0) return [];
    const match = toks.map((t) => `"${t}"`).join(" OR ");
    const rows = this.stmt(
      `SELECT n.* FROM nodes_fts f JOIN nodes n ON n.id = f.id
       WHERE f.tokens MATCH ? ORDER BY bm25(nodes_fts), n.id LIMIT ?`,
    ).all(match, limit) as NodeRow[];
    return rows.map((r) => this.rowToNode(r));
  }

  /** BM25 score per node id for a query (lower bm25 = better; we return -bm25 as score). */
  bm25Scores(query: string, limit: number): { id: string; score: number }[] {
    const toks = [...new Set(basicTokens(query))];
    if (toks.length === 0) return [];
    const match = toks.map((t) => `"${t}"`).join(" OR ");
    const rows = this.stmt(
      `SELECT f.id AS id, bm25(nodes_fts) AS b FROM nodes_fts f
       WHERE f.tokens MATCH ? ORDER BY b, f.id LIMIT ?`,
    ).all(match, limit) as { id: string; b: number }[];
    return rows.map((r) => ({ id: r.id, score: -r.b }));
  }

  allNodes(): GraphNode[] {
    return (this.stmt(`SELECT * FROM nodes ORDER BY id`).all() as NodeRow[]).map((r) => this.rowToNode(r));
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
      | { path: string; hash: string; mtime_ms: number; node_ids: string; role: string | null; analyzer_version: number } | undefined;
    return r ? { hash: r.hash, mtimeMs: r.mtime_ms, nodeIds: JSON.parse(r.node_ids), role: r.role ?? "library", analyzerVersion: r.analyzer_version } : undefined;
  }

  setFileMeta(path: string, meta: FileMeta): void {
    this.stmt(
      `INSERT OR REPLACE INTO files (path,hash,mtime_ms,node_ids,role,analyzer_version) VALUES (?,?,?,?,?,?)`,
    ).run(path, meta.hash, meta.mtimeMs, JSON.stringify(meta.nodeIds), meta.role, meta.analyzerVersion);
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
        this.stmt(`DELETE FROM nodes WHERE id = ?`).run(id);
        this.stmt(`DELETE FROM nodes_fts WHERE id = ?`).run(id);
        this.stmt(`DELETE FROM edges WHERE source = ? OR target = ?`).run(id, id);
      }
      this.stmt(`DELETE FROM files WHERE path = ?`).run(path);
      this.stmt(`DELETE FROM imports WHERE file = ?`).run(path);

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
