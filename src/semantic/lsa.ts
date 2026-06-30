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
 * Deterministic latent-semantic index. Find symbols "by meaning" using classical
 * TF-IDF + truncated SVD — no neural embeddings, no API, fully reproducible.
 */
export class LsaIndex {
  private constructor(
    private ids: string[],
    private tf: Tfidf,
    private u: number[][], // terms × k
    private docLatent: number[][], // docs × k
  ) {}

  static build(docs: SymbolDoc[], k = 100): LsaIndex {
    const ids = docs.map((d) => d.id);
    const tokens = docs.map((d) => docTokens(d.text));
    const tf = buildTfidf(tokens);
    const terms = tf.vocab.length;
    const nDocs = docs.length;
    const kk = Math.max(1, Math.min(k, terms, nDocs));

    const { u, s, v } = truncatedSvd(tf.matrix, kk, { seed: 1 });
    // doc latent = s ⊙ V[doc]
    const docLatent = v.map((row) => row.map((val, j) => val * s[j]));
    return new LsaIndex(ids, tf, u, docLatent);
  }

  query(text: string, limit = 20): Scored[] {
    const q = queryVector(this.tf, docTokens(text));
    const k = this.u[0]?.length ?? 0;
    // qhat = Uᵀ q
    const qhat = new Array<number>(k).fill(0);
    for (let t = 0; t < this.u.length; t++) {
      const qt = q[t];
      if (qt === 0) continue;
      const urow = this.u[t];
      for (let j = 0; j < k; j++) qhat[j] += urow[j] * qt;
    }
    const qn = norm(qhat);
    if (qn === 0) return [];

    const scored: Scored[] = this.ids.map((id, i) => {
      const d = this.docLatent[i];
      const dn = norm(d);
      const sim = dn === 0 ? 0 : dot(qhat, d) / (qn * dn);
      return { id, score: sim };
    });
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
      .slice(0, limit);
  }
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function norm(a: number[]): number {
  return Math.sqrt(dot(a, a));
}
