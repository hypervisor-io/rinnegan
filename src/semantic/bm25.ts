import { docTokens } from "./tokenize.js";
import type { Scored } from "./lsa.js";

export interface Bm25Doc {
  id: string;
  text: string;
}

/**
 * Serializable BM25 state: the tokenized corpus as a dictionary plus a flat
 * token-id stream and per-doc offsets. Integers only, so a round-trip is exact.
 */
export interface Bm25State {
  ids: string[]; // doc index order
  tokens: string[]; // token dictionary
  tokenIds: Uint32Array; // concatenated per-doc token ids
  offsets: Uint32Array; // docs+1 offsets into tokenIds
}

/** Standalone deterministic BM25 (k1=1.5, b=0.75) over tokenized symbol docs. */
export class Bm25Index {
  private ids: string[] = [];
  private docs: string[][] = [];
  private df = new Map<string, number>();
  private avgLen = 0;
  private k1 = 1.5;
  private b = 0.75;

  constructor(docs: Bm25Doc[]) {
    this.init(docs.map((d) => d.id), docs.map((d) => docTokens(d.text)));
  }

  /**
   * Rehydrate from persisted state. Skips tokenization AND, more importantly,
   * skips loading every node out of SQLite — on a large corpus `allNodes()` alone
   * dwarfs the BM25 arithmetic.
   */
  static fromState(state: Bm25State): Bm25Index {
    const idx = new Bm25Index([]);
    const dict = state.tokens;
    const docs: string[][] = new Array(state.ids.length);
    for (let i = 0; i < docs.length; i++) {
      const start = state.offsets[i];
      const end = state.offsets[i + 1];
      const row = new Array<string>(end - start);
      for (let j = start; j < end; j++) row[j - start] = dict[state.tokenIds[j]];
      docs[i] = row;
    }
    idx.init(state.ids, docs);
    return idx;
  }

  /** The state to persist — exactly what `fromState` consumes. */
  toState(): Bm25State {
    const dict: string[] = [];
    const dictIndex = new Map<string, number>();
    const offsets = new Uint32Array(this.docs.length + 1);
    const flat: number[] = [];
    for (let i = 0; i < this.docs.length; i++) {
      offsets[i] = flat.length;
      const row = this.docs[i];
      for (let j = 0; j < row.length; j++) {
        const t = row[j];
        let id = dictIndex.get(t);
        if (id === undefined) {
          id = dict.length;
          dict.push(t);
          dictIndex.set(t, id);
        }
        flat.push(id);
      }
    }
    offsets[this.docs.length] = flat.length;
    return { ids: this.ids, tokens: dict, tokenIds: Uint32Array.from(flat), offsets };
  }

  private init(ids: string[], docs: string[][]): void {
    this.ids = ids;
    this.docs = docs;
    this.df = new Map<string, number>();
    for (const toks of docs) {
      for (const t of new Set(toks)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    const total = docs.reduce((s, d) => s + d.length, 0);
    this.avgLen = docs.length ? total / docs.length : 0;
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
