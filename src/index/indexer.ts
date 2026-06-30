import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { GraphStore } from "../graph/store.js";
import { scanFiles, contentHash } from "../ingest/scanner.js";
import { parseFile } from "../parse/extract.js";

export interface IndexStats {
  scanned: number;
  parsed: number;
  skipped: number;
  nodes: number;
  edges: number;
}

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
      const abs = join(root, f.path);
      const st = statSync(abs);
      const meta = this.store.getFileMeta(f.path);

      // Gate 1: same mtime and already indexed → skip without reading.
      if (meta && meta.mtimeMs === st.mtimeMs) {
        skipped++;
        continue;
      }

      const content = readFileSync(abs, "utf8");
      const hash = contentHash(content);

      // Gate 2: content hash unchanged → refresh mtime only, skip reparse.
      if (meta && meta.hash === hash) {
        this.store.setFileMeta(f.path, { hash, mtimeMs: st.mtimeMs, nodeIds: meta.nodeIds });
        skipped++;
        continue;
      }

      if (meta) this.store.removeFile(f.path);
      const res = await parseFile(f.path, content, f.language);
      this.store.tx(() => {
        for (const n of res.nodes) this.store.insertNode(n);
        for (const e of res.edges) this.store.insertEdge(e);
      });
      this.store.setFileMeta(f.path, { hash, mtimeMs: st.mtimeMs, nodeIds: res.nodes.map((n) => n.id) });
      parsed++;
    }

    const s = this.store.stats();
    return { scanned: files.length, parsed, skipped, nodes: s.nodes, edges: s.edges };
  }
}
