import { readFileSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { GraphStore } from "../graph/store.js";
import { scanFiles, contentHash, LANG_EXT, type ScannedFile } from "../ingest/scanner.js";
import { parseFile } from "../parse/extract.js";
import { resolveImports } from "../resolution/imports.js";

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
    let parsed = 0;
    let skipped = 0;
    for (const f of files) {
      if (await this.indexOne(root, f)) parsed++;
      else skipped++;
    }
    // cross-file pass once all files are present
    this.store.tx(() => resolveImports(this.store));
    const s = this.store.stats();
    return { scanned: files.length, parsed, skipped, nodes: s.nodes, edges: s.edges };
  }

  /** Index one file with two-gate change detection. Returns true if (re)parsed. */
  private async indexOne(root: string, f: ScannedFile): Promise<boolean> {
    const abs = join(root, f.path);
    const st = statSync(abs);
    const meta = this.store.getFileMeta(f.path);

    if (meta && meta.mtimeMs === st.mtimeMs) return false; // gate 1
    const content = readFileSync(abs, "utf8");
    const hash = contentHash(content);
    if (meta && meta.hash === hash) {
      this.store.setFileMeta(f.path, { hash, mtimeMs: st.mtimeMs, nodeIds: meta.nodeIds, role: meta?.role ?? "library" });
      return false; // gate 2
    }

    if (meta) this.store.removeFile(f.path);
    const res = await parseFile(f.path, content, f.language);
    this.store.tx(() => {
      for (const n of res.nodes) this.store.insertNode(n);
      for (const e of res.edges) this.store.insertEdge(e);
      this.store.setImports(f.path, res.imports);
    });
    this.store.setFileMeta(f.path, { hash, mtimeMs: st.mtimeMs, nodeIds: res.nodes.map((n) => n.id), role: meta?.role ?? "library" });
    return true;
  }

  /**
   * Reconcile index with the working tree: reindex changed/new files, remove
   * deleted ones, refresh cross-file edges only if anything moved. Cheap when
   * nothing changed (scan + one stat per file — gate 1).
   */
  async sync(root: string): Promise<SyncStats> {
    const scanned = scanFiles(root);
    const onDisk = new Set(scanned.map((f) => f.path));
    let removed = 0;
    for (const path of this.store.allFilePaths()) {
      if (!onDisk.has(path)) { this.store.removeFile(path); removed++; }
    }
    let reindexed = 0;
    for (const f of scanned) if (await this.indexOne(root, f)) reindexed++;
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
    const changed = await this.indexOne(root, { path: relPath, size: st.size, language });
    this.store.tx(() => resolveImports(this.store));
    return changed ? "reindexed" : "skipped";
  }
}
