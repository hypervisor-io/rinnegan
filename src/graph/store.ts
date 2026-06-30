import Database from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphNode, GraphEdge, EdgeKind } from "../core/types.js";

const SCHEMA = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8");

export interface FileMeta {
  hash: string;
  mtimeMs: number;
  nodeIds: string[];
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

  private constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(SCHEMA);
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
    this.db.prepare(
      `INSERT OR REPLACE INTO nodes
       (id,kind,qualified_name,file_path,language,start_line,end_line,signature,docstring,is_exported)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(n.id, n.kind, n.qualifiedName, n.filePath, n.language, n.startLine, n.endLine,
      n.signature ?? null, n.docstring ?? null, n.isExported ? 1 : 0);

    const tokens = basicTokens(`${n.qualifiedName} ${n.signature ?? ""} ${n.docstring ?? ""}`).join(" ");
    this.db.prepare(`DELETE FROM nodes_fts WHERE id = ?`).run(n.id);
    this.db.prepare(`INSERT INTO nodes_fts (id, tokens) VALUES (?, ?)`).run(n.id, tokens);
  }

  insertEdge(e: GraphEdge): void {
    this.db.prepare(
      `INSERT INTO edges (source,target,kind,line,col,provenance,confidence,resolver,read_write,metadata)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(e.source, e.target, e.kind, e.line, e.col, e.provenance, e.confidence, e.resolver,
      e.readWrite ?? null, e.metadata ? JSON.stringify(e.metadata) : null);
  }

  getNode(id: string): GraphNode | undefined {
    const r = this.db.prepare(`SELECT * FROM nodes WHERE id = ?`).get(id) as NodeRow | undefined;
    return r ? this.rowToNode(r) : undefined;
  }

  outgoing(id: string, kinds?: EdgeKind[]): GraphEdge[] {
    const rows = this.db.prepare(
      `SELECT * FROM edges WHERE source = ? ORDER BY target, kind, line`,
    ).all(id) as EdgeRow[];
    const edges = rows.map((r) => this.rowToEdge(r));
    return kinds ? edges.filter((e) => kinds.includes(e.kind)) : edges;
  }

  incoming(id: string, kinds?: EdgeKind[]): GraphEdge[] {
    const rows = this.db.prepare(
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
    const rows = this.db.prepare(
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
    const rows = this.db.prepare(
      `SELECT f.id AS id, bm25(nodes_fts) AS b FROM nodes_fts f
       WHERE f.tokens MATCH ? ORDER BY b, f.id LIMIT ?`,
    ).all(match, limit) as { id: string; b: number }[];
    return rows.map((r) => ({ id: r.id, score: -r.b }));
  }

  allNodes(): GraphNode[] {
    return (this.db.prepare(`SELECT * FROM nodes ORDER BY id`).all() as NodeRow[]).map((r) => this.rowToNode(r));
  }

  allEdges(): GraphEdge[] {
    return (this.db.prepare(`SELECT * FROM edges ORDER BY source,target,kind,line`).all() as EdgeRow[])
      .map((r) => this.rowToEdge(r));
  }

  getFileMeta(path: string): FileMeta | undefined {
    const r = this.db.prepare(`SELECT * FROM files WHERE path = ?`).get(path) as
      | { path: string; hash: string; mtime_ms: number; node_ids: string } | undefined;
    return r ? { hash: r.hash, mtimeMs: r.mtime_ms, nodeIds: JSON.parse(r.node_ids) } : undefined;
  }

  setFileMeta(path: string, meta: FileMeta): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO files (path,hash,mtime_ms,node_ids) VALUES (?,?,?,?)`,
    ).run(path, meta.hash, meta.mtimeMs, JSON.stringify(meta.nodeIds));
  }

  /** Remove all nodes/edges that originated from a file (for re-index). */
  removeFile(path: string): void {
    const meta = this.getFileMeta(path);
    if (!meta) return;
    const del = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        this.db.prepare(`DELETE FROM nodes WHERE id = ?`).run(id);
        this.db.prepare(`DELETE FROM nodes_fts WHERE id = ?`).run(id);
        this.db.prepare(`DELETE FROM edges WHERE source = ? OR target = ?`).run(id, id);
      }
      this.db.prepare(`DELETE FROM files WHERE path = ?`).run(path);
    });
    del(meta.nodeIds);
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

  stats(): { nodes: number; edges: number; files: number } {
    const n = (this.db.prepare(`SELECT count(*) c FROM nodes`).get() as { c: number }).c;
    const e = (this.db.prepare(`SELECT count(*) c FROM edges`).get() as { c: number }).c;
    const f = (this.db.prepare(`SELECT count(*) c FROM files`).get() as { c: number }).c;
    return { nodes: n, edges: e, files: f };
  }
}
