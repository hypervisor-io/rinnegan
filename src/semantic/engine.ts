import { GraphStore } from "../graph/store.js";
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
    private lsa: LsaIndex,
    private bm25: Bm25Index,
  ) {}

  static build(store: GraphStore): SemanticEngine {
    const nodes = store.allNodes().filter((n) => !["file", "unresolved", "import"].includes(n.kind));
    const docs = nodes.map((n) => ({
      id: n.id,
      text: `${n.qualifiedName} ${n.signature ?? ""} ${n.docstring ?? ""}`,
    }));
    return new SemanticEngine(LsaIndex.build(docs), new Bm25Index(docs));
  }

  seed(query: string, limit = 8): Scored[] {
    const lists = [this.lsa.query(query, limit * 3), this.bm25.search(query, limit * 3)];
    return rrfFuse(lists).slice(0, limit);
  }

  relevance(query: string): Map<string, number> {
    const fused = rrfFuse([this.lsa.query(query, 300), this.bm25.search(query, 300)]);
    const max = fused[0]?.score ?? 1;
    return new Map(fused.map((s) => [s.id, max ? s.score / max : 0]));
  }
}
