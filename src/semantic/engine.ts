import { GraphStore, basicTokens } from "../graph/store.js";
import { LsaIndex, type Scored } from "./lsa.js";
import { Bm25Index } from "./bm25.js";
import { rrfFuse } from "./fuse.js";

/**
 * Combines the deterministic semantic indices (LSA + BM25) built over the graph's
 * symbols. `seed` returns fused anchor candidates; `relevance` returns a normalized
 * per-node relevance map used by the signal ranker.
 */
export class SemanticEngine {
  private constructor(
    private store: GraphStore,
    private lsa: LsaIndex,
    private bm25: Bm25Index,
  ) {}

  static build(store: GraphStore): SemanticEngine {
    const nodes = store.allNodes().filter((n) => !["file", "unresolved", "import"].includes(n.kind));
    const docs = nodes.map((n) => ({
      id: n.id,
      text: `${n.qualifiedName} ${n.signature ?? ""} ${n.docstring ?? ""}`,
    }));
    return new SemanticEngine(store, LsaIndex.build(docs), new Bm25Index(docs));
  }

  seed(query: string, limit = 8): Scored[] {
    const lists = [this.lsa.query(query, limit * 3), this.bm25.search(query, limit * 3)];
    const fused = rrfFuse(lists).slice(0, limit);
    if (fused.length >= limit) return fused;
    // Whole-token FTS/LSA cannot see a query token that only occurs as a
    // substring of an identifier ("vnc" inside novnc/vncTicket) — blind A/B
    // judging showed that gap hides the exact production symbols a task needs.
    // Fill the tail with substring matches at the lowest score: they can seed
    // the spine, never outrank a true lexical/latent match.
    const seen = new Set(fused.map((s) => s.id));
    const toks = [...new Set(basicTokens(query))].filter((t) => t.length >= 3);
    for (const n of this.store.searchTokensSubstring(toks, limit * 3)) {
      if (fused.length >= limit) break;
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      fused.push({ id: n.id, score: 0.001 });
    }
    return fused;
  }

  relevance(query: string): Map<string, number> {
    const fused = rrfFuse([this.lsa.query(query, 300), this.bm25.search(query, 300)]);
    const max = fused[0]?.score ?? 1;
    return new Map(fused.map((s) => [s.id, max ? s.score / max : 0]));
  }
}
