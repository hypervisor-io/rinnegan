import { readFileSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { GraphStore } from "../graph/store.js";
import { scanFiles, contentHash, LANG_EXT, type ScannedFile } from "../ingest/scanner.js";
import { parseFile, ANALYZER_VERSION } from "../parse/extract.js";
import { resolveImports } from "../resolution/imports.js";
import { classifyFile, buildClassifyContext, type ClassifyContext } from "../ingest/classify.js";

export interface IndexStats {
  scanned: number;
  parsed: number;
  skipped: number;
  nodes: number;
  edges: number;
}

export interface SyncStats { reindexed: number; removed: number }

/**
 * Orchestrates scan → two-gate change detection → parse → atomic persist.
 * Deterministic: files processed in sorted order; inserts batched per file.
 */
export class Indexer {
  constructor(private store: GraphStore) {}

  async indexAll(root: string): Promise<IndexStats> {
    const files = scanFiles(root);
    const ctx = buildClassifyContext(root, files.filter((f) => f.language === "manifest").map((f) => f.path));
    let parsed = 0;
    let skipped = 0;
    for (const f of files) {
      if (await this.indexOne(root, f, ctx)) parsed++;
      else skipped++;
    }
    // cross-file pass once all files are present
    this.store.tx(() => resolveImports(this.store));
    const s = this.store.stats();
    return { scanned: files.length, parsed, skipped, nodes: s.nodes, edges: s.edges };
  }

  /** Index one file with two-gate change detection. Returns true if (re)parsed. */
  private async indexOne(root: string, f: ScannedFile, ctx: ClassifyContext): Promise<boolean> {
    const abs = join(root, f.path);
    const st = statSync(abs);
    const meta = this.store.getFileMeta(f.path);
    // Both gates also require the file to have been analyzed at the current
    // ANALYZER_VERSION; a stale version means the stored nodes/edges came from
    // older parse logic and must be regenerated even if the bytes are identical.
    const fresh = meta?.analyzerVersion === ANALYZER_VERSION;

    if (meta && fresh && meta.mtimeMs === st.mtimeMs) return false; // gate 1
    const content = readFileSync(abs, "utf8");
    const hash = contentHash(content);
    if (meta && fresh && meta.hash === hash) {
      this.store.setFileMeta(f.path, { hash, mtimeMs: st.mtimeMs, nodeIds: meta.nodeIds, role: meta.role, analyzerVersion: ANALYZER_VERSION });
      return false; // gate 2
    }

    if (meta) this.store.removeFile(f.path);
    const res = await parseFile(f.path, content, f.language);
    const role = classifyFile(f.path, content, f.language, res.imports.map((i) => i.moduleSpec), ctx);
    this.store.tx(() => {
      for (const n of res.nodes) this.store.insertNode(n);
      for (const e of res.edges) this.store.insertEdge(e);
      this.store.setImports(f.path, res.imports);
    });
    this.store.setFileMeta(f.path, { hash, mtimeMs: st.mtimeMs, nodeIds: res.nodes.map((n) => n.id), role, analyzerVersion: ANALYZER_VERSION });
    return true;
  }

  /**
   * Reconcile index with the working tree: reindex changed/new files, remove
   * deleted ones, refresh cross-file edges only if anything moved. Cheap when
   * nothing changed (scan + one stat per file — gate 1).
   */
  async sync(root: string): Promise<SyncStats> {
    const scanned = scanFiles(root);
    const ctx = buildClassifyContext(root, scanned.filter((f) => f.language === "manifest").map((f) => f.path));
    const onDisk = new Set(scanned.map((f) => f.path));
    let removed = 0;
    for (const path of this.store.allFilePaths()) {
      if (!onDisk.has(path)) { this.store.removeFile(path); removed++; }
    }
    let reindexed = 0;
    for (const f of scanned) if (await this.indexOne(root, f, ctx)) reindexed++;
    if (reindexed + removed > 0) this.store.tx(() => resolveImports(this.store));
    return { reindexed, removed };
  }

  /** Re-index a single file (or remove it if gone), then refresh cross-file edges. */
  async reindexPath(root: string, relPath: string): Promise<"reindexed" | "removed" | "skipped"> {
    const language = LANG_EXT[extname(relPath).toLowerCase()];
    if (!language) return "skipped";
    const abs = join(root, relPath);
    if (!existsSync(abs)) {
      this.store.removeFile(relPath);
      this.store.tx(() => resolveImports(this.store));
      return "removed";
    }
    const st = statSync(abs);
    const scanned = scanFiles(root);
    const ctx = buildClassifyContext(root, scanned.filter((f) => f.language === "manifest").map((f) => f.path));
    const changed = await this.indexOne(root, { path: relPath, size: st.size, language }, ctx);
    this.store.tx(() => resolveImports(this.store));
    return changed ? "reindexed" : "skipped";
  }
}
