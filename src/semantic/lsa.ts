import { buildTfidf, queryVector, type Tfidf } from "./tfidf.js";
import { truncatedSvd } from "./svd.js";
import { docTokens } from "./tokenize.js";

export interface SymbolDoc {
  id: string;
  text: string;
}

export interface Scored {
  id: string;
  score: number;
}

/**
 * The query-time half of a TF-IDF space: the vocabulary, its term index and the
 * IDF weights. A built `Tfidf` satisfies it; so does a deserialized cache entry,
 * which has no sparse matrix (it is only needed to *build* the SVD).
 */
export type TfidfSpace = Pick<Tfidf, "vocab" | "termIndex" | "idf">;

/**
 * Serializable LSA state — everything a query needs, and nothing else.
 *
 * `u` is terms×k and `docLatent` is docs×k, both row-major Float32. Float32 is
 * deliberate: the build path quantizes through the same Float32Array the cache
 * stores, so a built index and a loaded index hold bit-identical numbers and
 * therefore return bit-identical scores (determinism is a product promise, not
 * an approximation target).
 */
export interface LsaState {
  ids: string[]; // doc index order
  vocab: string[];
  idf: number[];
  k: number;
  u: Float32Array;
  docLatent: Float32Array;
}

/**
 * Deterministic latent-semantic index. Find symbols "by meaning" using classical
 * TF-IDF + truncated SVD — no neural embeddings, no API, fully reproducible.
 */
export class LsaIndex {
  private constructor(
    private ids: string[],
    private space: TfidfSpace,
    private k: number,
    private u: Float32Array, // terms × k, term-major
    private docLatent: Float32Array, // docs × k, doc-major
    private docNorms: Float32Array, // ‖docLatent[i]‖
  ) {}

  static build(docs: SymbolDoc[], k = 96): LsaIndex {
    const ids = docs.map((d) => d.id);
    const tokens = docs.map((d) => docTokens(d.text));
    const tf = buildTfidf(tokens);
    const nDocs = docs.length;
    const kk = Math.max(1, Math.min(k, tf.vocab.length, nDocs));

    const { u, s, v } = truncatedSvd(tf.sparse, kk, { seed: 1 });
    const dims = u[0]?.length ?? 0;
    // doc latent = s ⊙ V[doc]
    const docLatent = v.map((row) => row.map((val, j) => val * s[j]));

    // Quantize once, into the exact shape the cache round-trips.
    const u32 = new Float32Array(u.length * dims);
    for (let t = 0; t < u.length; t++) u32.set(u[t], t * dims);
    const dl32 = new Float32Array(nDocs * dims);
    for (let i = 0; i < nDocs; i++) dl32.set(docLatent[i], i * dims);

    return new LsaIndex(ids, tf, dims, u32, dl32, normsOf(dl32, dims));
  }

  /** Rehydrate from persisted state. Cheap: no tokenization, no SVD. */
  static fromState(state: LsaState): LsaIndex {
    const termIndex = new Map<string, number>();
    state.vocab.forEach((t, i) => termIndex.set(t, i));
    const space: TfidfSpace = { vocab: state.vocab, termIndex, idf: state.idf };
    return new LsaIndex(state.ids, space, state.k, state.u, state.docLatent, normsOf(state.docLatent, state.k));
  }

  /** The state to persist — exactly what `fromState` consumes. */
  toState(): LsaState {
    return {
      ids: this.ids,
      vocab: this.space.vocab,
      idf: this.space.idf,
      k: this.k,
      u: this.u,
      docLatent: this.docLatent,
    };
  }

  query(text: string, limit = 20): Scored[] {
    const q = queryVector(this.space, docTokens(text));
    const k = this.k;
    // qhat = Uᵀ q
    const qhat = new Array<number>(k).fill(0);
    for (let t = 0; t < this.space.vocab.length; t++) {
      const qt = q[t];
      if (qt === 0) continue;
      const base = t * k;
      for (let j = 0; j < k; j++) qhat[j] += this.u[base + j] * qt;
    }
    const qn = norm(qhat);
    if (qn === 0) return [];

    const scored: Scored[] = this.ids.map((id, i) => {
      const dn = this.docNorms[i];
      if (dn === 0) return { id, score: 0 };
      let dotp = 0;
      const base = i * k;
      for (let j = 0; j < k; j++) dotp += qhat[j] * this.docLatent[base + j];
      return { id, score: dotp / (qn * dn) };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
      .slice(0, limit);
  }
}

function normsOf(rows: Float32Array, k: number): Float32Array {
  const n = k === 0 ? 0 : rows.length / k;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const base = i * k;
    for (let j = 0; j < k; j++) s += rows[base + j] * rows[base + j];
    out[i] = Math.sqrt(s);
  }
  return out;
}

function norm(a: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s);
}
