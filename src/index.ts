import { join } from "node:path";
import { GraphStore } from "./graph/store.js";
import { Indexer, type IndexStats } from "./index/indexer.js";
import { SemanticEngine } from "./semantic/engine.js";
import { Watcher, type WatchEvent } from "./watch/watcher.js";
import { understand, type UnderstandOpts, type UnderstandResult } from "./signal/understand.js";
import type { GraphNode, GraphEdge, ReadWrite } from "./core/types.js";

export { VERSION } from "./version.js";
export type { GraphNode, GraphEdge, Provenance, ReadWrite, NodeKind, EdgeKind } from "./core/types.js";
export type { IndexStats } from "./index/indexer.js";
export type { UnderstandResult } from "./signal/understand.js";

export interface VeridexOpts {
  dbPath?: string;
}

/** The Veridex public API — the shared core behind the CLI and MCP server. */
export class Veridex {
  private semantic: SemanticEngine | null = null;

  private constructor(
    public readonly root: string,
    private store: GraphStore,
  ) {}

  static open(root: string, opts: VeridexOpts = {}): Veridex {
    const dbPath = opts.dbPath ?? join(root, ".veridex", "graph.db");
    return new Veridex(root, GraphStore.open(dbPath));
  }

  async indexAll(): Promise<IndexStats> {
    const stats = await new Indexer(this.store).indexAll(this.root);
    // semantic (LSA) is built lazily on first understand/seed — keeps `index` fast
    this.semantic = null;
    return stats;
  }

  private sem(): SemanticEngine {
    if (!this.semantic) this.semantic = SemanticEngine.build(this.store);
    return this.semantic;
  }

  understand(task: string, opts: Partial<UnderstandOpts> = {}): UnderstandResult {
    return understand(this.store, this.sem(), task, { root: this.root, ...opts });
  }

  /** Re-index a single file (after an external edit) and invalidate the semantic cache. */
  async reindexFile(relPath: string): Promise<"reindexed" | "removed" | "skipped"> {
    const r = await new Indexer(this.store).reindexPath(this.root, relPath);
    if (r !== "skipped") this.semantic = null;
    return r;
  }

  /** Start a live file watcher that keeps the index in sync. Returns the watcher. */
  watch(onChange?: (e: WatchEvent) => void): Watcher {
    const w = new Watcher(this.store, this.root, {
      onChange,
      onSemanticInvalidate: () => {
        this.semantic = null;
      },
    });
    w.start();
    return w;
  }

  search(query: string, limit = 20): GraphNode[] {
    return this.store.searchFts(query, limit);
  }

  /** Resolve a symbol name/qualified-name to its best node. */
  resolveSymbol(name: string): GraphNode | undefined {
    const all = this.store.allNodes();
    return (
      all.find((n) => n.qualifiedName === name) ??
      all.find((n) => n.qualifiedName.endsWith(`.${name}`)) ??
      this.store.searchFts(name, 1)[0]
    );
  }

  /** File-scoped dependency query (codegraph #500): what this file's symbols call/reference out. */
  deps(filePath: string): { file: string; dependencies: { name: string; provenance: string; kind: string }[] } {
    const own = new Set(this.store.allNodes().filter((n) => n.filePath === filePath).map((n) => n.id));
    const seen = new Map<string, { name: string; provenance: string; kind: string }>();
    for (const id of own) {
      for (const e of this.store.outgoing(id, ["calls", "references", "imports"])) {
        if (own.has(e.target)) continue; // internal, not a dependency
        const t = this.store.getNode(e.target);
        if (!t) continue;
        seen.set(e.target, { name: t.qualifiedName, provenance: e.provenance, kind: e.kind });
      }
    }
    return {
      file: filePath,
      dependencies: [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : 1)),
    };
  }

  /** References to a symbol, optionally filtered by read/write (codegraph #996). */
  refs(symbol: string, opts: { readWrite?: ReadWrite } = {}): GraphEdge[] {
    const node = this.resolveSymbol(symbol);
    if (!node) return [];
    const edges = this.store.incoming(node.id, ["references"]);
    return opts.readWrite ? edges.filter((e) => e.readWrite === opts.readWrite) : edges;
  }

  callers(symbol: string): GraphNode[] {
    const node = this.resolveSymbol(symbol);
    if (!node) return [];
    return this.store
      .incoming(node.id, ["calls"])
      .map((e) => this.store.getNode(e.source))
      .filter((n): n is GraphNode => !!n);
  }

  /** Blast radius: who is (transitively) affected by changing this symbol. */
  impact(symbol: string, depth = 3): GraphNode[] {
    const node = this.resolveSymbol(symbol);
    if (!node) return [];
    const seen = new Set<string>([node.id]);
    let frontier = [node.id];
    for (let d = 0; d < depth; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const e of this.store.incoming(id, ["calls", "references"])) {
          if (!seen.has(e.source)) {
            seen.add(e.source);
            next.push(e.source);
          }
        }
      }
      frontier = next;
    }
    seen.delete(node.id);
    return [...seen].map((id) => this.store.getNode(id)).filter((n): n is GraphNode => !!n);
  }

  stats() {
    return this.store.stats();
  }

  close(): void {
    this.store.close();
  }
}
