import { GraphStore, basicTokens } from "../graph/store.js";
import { LsaIndex, type Scored, type SymbolDoc } from "./lsa.js";
import { Bm25Index } from "./bm25.js";
import { rrfFuse } from "./fuse.js";
import { deserializeModel, serializeModel, TOKENIZER_VERSION } from "./cache.js";

/** Kinds that carry no retrievable meaning — excluded from the semantic model. */
const NON_SEMANTIC_KINDS = new Set(["file", "unresolved", "import"]);

/**
 * The symbol documents the semantic model is built over, in `allNodes()` order
 * (ORDER BY id). Deterministic inputs are the whole determinism story: same
 * corpus ⇒ same docs ⇒ same ids ⇒ same index bytes.
 */
function symbolDocs(store: GraphStore): SymbolDoc[] {
  return store
    .allNodes()
    .filter((n) => !NON_SEMANTIC_KINDS.has(n.kind))
    .map((n) => ({
      id: n.id,
      text: `${n.qualifiedName} ${n.signature ?? ""} ${n.docstring ?? ""}`,
    }));
}

/**
 * Corpus identity for the semantic cache: the tokenizer recipe version, the
 * store's content fingerprint (file path + hash + analyzer version — the value
 * `rinnegan status` prints) plus the node count, so a graph mutation that does
 * not come from a file re-index (a direct insertNode, a migration) also
 * invalidates the model.
 */
export function semanticCacheKey(store: GraphStore): string {
  const { nodes } = store.stats();
  return `${TOKENIZER_VERSION}:${nodes}:${store.fingerprint()}`;
}

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

  /** Build from scratch: tokenize + TF-IDF + SVD, no cache read or write. */
  static build(store: GraphStore): SemanticEngine {
    const docs = symbolDocs(store);
    return new SemanticEngine(store, LsaIndex.build(docs), new Bm25Index(docs));
  }

  /**
   * Load the model, persisting it so the next process skips the rebuild.
   *
   * The truncated SVD dominates build time — O(k² · docs) per iteration, minutes
   * on a large corpus — so the LSA state (doc vectors, the query projection
   * basis, vocab/IDF, the id order) is what must survive a process. BM25 itself
   * is arithmetic-light, but its *inputs* cost as much as the SVD's: rebuilding it
   * requires `store.allNodes()` over the whole graph (13.8 s on the 229k-node
   * corpus) plus a tokenization pass. Persisting the token-id stream is therefore
   * not premature — it is what makes a cache hit touch SQLite only for one row.
   */
  static load(store: GraphStore): SemanticEngine {
    const key = semanticCacheKey(store);
    const payload = store.readSemanticCache(key);
    const state = payload ? deserializeModel(payload) : undefined;
    if (state) {
      return new SemanticEngine(store, LsaIndex.fromState(state.lsa), Bm25Index.fromState(state.bm25));
    }

    const docs = symbolDocs(store);
    const lsa = LsaIndex.build(docs);
    const bm25 = new Bm25Index(docs);
    store.writeSemanticCache(key, serializeModel({ lsa: lsa.toState(), bm25: bm25.toState() }));
    return new SemanticEngine(store, lsa, bm25);
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
