import { docTokens } from "./tokenize.js";
import type { Scored } from "./lsa.js";

export interface Bm25Doc {
  id: string;
  text: string;
}

/** Standalone deterministic BM25 (k1=1.5, b=0.75) over tokenized symbol docs. */
export class Bm25Index {
  private ids: string[];
  private docs: string[][];
  private df = new Map<string, number>();
  private avgLen: number;
  private k1 = 1.5;
  private b = 0.75;

  constructor(docs: Bm25Doc[]) {
    this.ids = docs.map((d) => d.id);
    this.docs = docs.map((d) => docTokens(d.text));
    for (const toks of this.docs) {
      for (const t of new Set(toks)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    const total = this.docs.reduce((s, d) => s + d.length, 0);
    this.avgLen = this.docs.length ? total / this.docs.length : 0;
  }

  search(query: string, limit = 20): Scored[] {
    const qToks = [...new Set(docTokens(query))];
    const N = this.docs.length;
    const out: Scored[] = [];
    for (let i = 0; i < N; i++) {
      const doc = this.docs[i];
      const len = doc.length || 1;
      const freq = new Map<string, number>();
      for (const t of doc) freq.set(t, (freq.get(t) ?? 0) + 1);
      let score = 0;
      for (const qt of qToks) {
        const f = freq.get(qt);
        if (!f) continue;
        const n = this.df.get(qt) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += idf * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * (len / this.avgLen)));
      }
      if (score > 0) out.push({ id: this.ids[i], score });
    }
    return out
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
      .slice(0, limit);
  }
}
