import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { GraphStore } from "./graph/store.js";
import { Indexer, type IndexStats, type SyncStats } from "./index/indexer.js";
import { SemanticEngine } from "./semantic/engine.js";
import { Watcher, type WatchEvent } from "./watch/watcher.js";
import { understand, type UnderstandOpts, type UnderstandResult } from "./signal/understand.js";
import { languageOf } from "./ingest/scanner.js";
import { parseUnifiedDiff, applyDiff } from "./verify/diff.js";
import { verifyChanges, sortFindings, type VerifyReport, type VerifyInput, type Finding } from "./verify/verify.js";
import type { GraphNode, GraphEdge, ReadWrite } from "./core/types.js";

export { VERSION } from "./version.js";
export type { GraphNode, GraphEdge, Provenance, ReadWrite, NodeKind, EdgeKind } from "./core/types.js";
export type { IndexStats } from "./index/indexer.js";
export { type SyncStats } from "./index/indexer.js";
export type { UnderstandResult } from "./signal/understand.js";
export type { VerifyReport, VerifyInput, Finding, FindingRule } from "./verify/verify.js";

export interface RinneganOpts {
  dbPath?: string;
}

export type LookupResult =
  | { found: true; node: GraphNode; callers: number }
  | { found: false; message: string; suggestions: { name: string; file: string; line: number }[] };

/** `lookup`'s rendering, shared by the CLI and MCP surfaces. */
export function renderLookup(r: LookupResult): string {
  if (r.found) {
    return `${r.node.qualifiedName}  [${r.node.kind}]\n${r.node.signature ?? "(no signature)"}\n${r.node.filePath}:${r.node.startLine}\ncallers: ${r.callers}`;
  }
  if (r.suggestions.length === 0) return r.message;
  return [r.message, "did you mean:", ...r.suggestions.map((s) => `${s.file}:${s.line}  ${s.name}`)].join("\n");
}

export interface InventoryRow {
  path: string;
  role: string;
  language: string;
  symbols: number; // non-file nodes in this file
  inboundEdges: number; // edges into this file's nodes from other files' nodes
  orphaned: boolean; // inboundEdges === 0 && role !== "entrypoint"
}

/** Human-readable freshness line prepended to slices by the CLI/MCP surfaces. */
export function freshnessStamp(s: SyncStats): string {
  return s.reindexed + s.removed === 0
    ? "# index: fresh"
    : `# index: ${s.reindexed} file(s) reindexed, ${s.removed} removed just now`;
}

/** The Rinnegan public API — the shared core behind the CLI and MCP server. */
export class Rinnegan {
  private semantic: SemanticEngine | null = null;

  private constructor(
    public readonly root: string,
    private store: GraphStore,
  ) {}

  static open(root: string, opts: RinneganOpts = {}): Rinnegan {
    const dbPath = opts.dbPath ?? join(root, ".rinnegan", "graph.db");
    return new Rinnegan(root, GraphStore.open(dbPath));
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

  /** Reconcile index with the working tree. Answers must never be stale. */
  async refresh(): Promise<SyncStats> {
    const s = await new Indexer(this.store).sync(this.root);
    if (s.reindexed + s.removed > 0) this.semantic = null;
    return s;
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

  /**
   * Exact symbol fact or an explicit NOT FOUND — no FTS fallback, so this
   * never quietly guesses (contrast with `resolveSymbol`, which does).
   */
  lookup(name: string): LookupResult {
    const candidates = this.store
      .allNodes()
      .filter((n) => n.kind !== "file" && n.kind !== "import" && n.kind !== "unresolved")
      .filter((n) => n.qualifiedName === name || n.qualifiedName.endsWith(`.${name}`));
    // allNodes() is ORDER BY id, so the first exact match (else first suffix match) is deterministic.
    const node = candidates.find((n) => n.qualifiedName === name) ?? candidates[0];
    if (!node) {
      return {
        found: false,
        message: `NOT FOUND — no symbol named '${name}' exists in this codebase. Do not invent it.`,
        suggestions: this.store.searchFts(name, 3).map((n) => ({ name: n.qualifiedName, file: n.filePath, line: n.startLine })),
      };
    }
    return { found: true, node, callers: this.store.incoming(node.id, ["calls"]).length };
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

  /** Per-file inventory: role, language, symbol count, inbound edges, orphan status. Sorted by path. */
  inventory(): InventoryRow[] {
    const roles = this.store.roleByFile();
    const nodes = this.store.allNodes();
    const fileOf = new Map(nodes.map((n) => [n.id, n.filePath]));
    const symbols = new Map<string, number>();
    const inbound = new Map<string, number>();
    for (const n of nodes) {
      if (n.kind === "file") continue;
      symbols.set(n.filePath, (symbols.get(n.filePath) ?? 0) + 1);
    }
    for (const e of this.store.allEdges()) {
      const sf = fileOf.get(e.source), tf = fileOf.get(e.target);
      if (sf && tf && sf !== tf) inbound.set(tf, (inbound.get(tf) ?? 0) + 1);
    }
    return [...roles.entries()].map(([path, role]) => {
      const inb = inbound.get(path) ?? 0;
      return {
        path, role,
        language: languageOf(path) ?? "unknown",
        symbols: symbols.get(path) ?? 0,
        inboundEdges: inb,
        orphaned: inb === 0 && role !== "entrypoint",
      };
    });
  }

  /** `.rinnegan-allow` entries merged with the caller-supplied allowlist (shared by `verify` and `verifyInputs`). */
  private mergeAllow(extra?: string[]): Set<string> {
    const allow = new Set(extra ?? []);
    const allowFile = join(this.root, ".rinnegan-allow");
    if (existsSync(allowFile)) {
      for (const line of readFileSync(allowFile, "utf8").split("\n")) {
        const t = line.trim();
        if (t && !t.startsWith("#")) allow.add(t);
      }
    }
    return allow;
  }

  /**
   * Graph-native fact-check of a diff: unknown symbols, ground-truth signature
   * echoes, and blast radius of edited definitions. Never mutates the on-disk
   * index — the overlay it builds lives inside a transaction that always
   * rolls back (see verify.ts).
   */
  async verify(diffText: string, opts: { allow?: string[] } = {}): Promise<VerifyReport> {
    const files = parseUnifiedDiff(diffText);
    const inputs: VerifyInput[] = [];
    const parseFailures: Finding[] = [];
    for (const f of files) {
      if (f.deleted) {
        inputs.push({ path: f.path, postImage: null, addedRanges: f.addedRanges });
        continue;
      }
      try {
        const original = f.created ? "" : readFileSync(join(this.root, f.path), "utf8");
        inputs.push({ path: f.path, postImage: applyDiff(original, f.hunks), addedRanges: f.addedRanges });
      } catch (err) {
        parseFailures.push({
          severity: "error",
          rule: "parse-failure",
          file: f.path,
          line: 1,
          message: `failed to read/apply diff for ${f.path}: ${(err as Error).message}`,
        });
      }
    }

    const report = await verifyChanges(this.store, this.root, inputs, { allow: this.mergeAllow(opts.allow) });
    if (parseFailures.length) {
      report.findings.push(...parseFailures);
      report.findings = sortFindings(report.findings);
    }
    return report;
  }

  /**
   * Fact-check pre-built `VerifyInput[]`s directly, skipping the diff
   * parser/applier — for callers (like `--staged`) that already have each
   * file's post-image from another source (e.g. the git index via `git
   * show`).
   */
  async verifyInputs(inputs: VerifyInput[], opts: { allow?: string[] } = {}): Promise<VerifyReport> {
    return verifyChanges(this.store, this.root, inputs, { allow: this.mergeAllow(opts.allow) });
  }

  close(): void {
    this.store.close();
  }
}
