import { watch, type FSWatcher } from "node:fs";
import { sep } from "node:path";
import { GraphStore } from "../graph/store.js";
import { Indexer } from "../index/indexer.js";

const IGNORE_SEG = new Set([
  "node_modules", ".git", "dist", "build", "out", "vendor", "target", ".veridex",
  "coverage", ".next", "__pycache__",
]);

export interface WatchEvent {
  path: string;
  result: "reindexed" | "removed" | "skipped";
}

/**
 * Live index sync. Debounced recursive watch; on change, re-index just that file
 * and refresh cross-file edges. `onSemanticInvalidate` lets the owner drop a cached
 * semantic index so the next query rebuilds it.
 */
export class Watcher {
  private fsw: FSWatcher | null = null;
  private pending = new Map<string, NodeJS.Timeout>();
  private indexer: Indexer;

  constructor(
    private store: GraphStore,
    private root: string,
    private opts: { debounceMs?: number; onChange?: (e: WatchEvent) => void; onSemanticInvalidate?: () => void } = {},
  ) {
    this.indexer = new Indexer(store);
  }

  private ignored(rel: string): boolean {
    return rel.split(sep).some((s) => IGNORE_SEG.has(s));
  }

  start(): void {
    const debounce = this.opts.debounceMs ?? 150;
    this.fsw = watch(this.root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = filename.toString();
      if (this.ignored(rel)) return;
      const existing = this.pending.get(rel);
      if (existing) clearTimeout(existing);
      this.pending.set(rel, setTimeout(() => void this.flush(rel), debounce));
    });
  }

  private async flush(rel: string): Promise<void> {
    this.pending.delete(rel);
    const result = await this.indexer.reindexPath(this.root, rel);
    if (result !== "skipped") this.opts.onSemanticInvalidate?.();
    this.opts.onChange?.({ path: rel, result });
  }

  stop(): void {
    this.fsw?.close();
    this.fsw = null;
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }
}
