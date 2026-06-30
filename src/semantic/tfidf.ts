/** TF-IDF term–document matrix builder. Deterministic; vocab sorted. */

export interface Tfidf {
  vocab: string[];
  termIndex: Map<string, number>;
  idf: number[];
  /** terms × docs weighted matrix */
  matrix: number[][];
}

/** Build a TF-IDF matrix from per-document token lists. Vocab capped to keep SVD tractable. */
export function buildTfidf(docsTokens: string[][], maxVocab = 2000): Tfidf {
  const N = docsTokens.length;
  const df = new Map<string, number>();
  for (const toks of docsTokens) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  }

  // keep most informative terms: appear in >1 doc OR corpus small; cap by df then alpha
  let vocab = [...df.keys()].sort((a, b) => {
    const da = df.get(a)!;
    const db = df.get(b)!;
    return db - da || (a < b ? -1 : 1);
  });
  if (vocab.length > maxVocab) vocab = vocab.slice(0, maxVocab);
  vocab.sort();

  const termIndex = new Map<string, number>();
  vocab.forEach((t, i) => termIndex.set(t, i));

  const idf = vocab.map((t) => Math.log(1 + N / (df.get(t)! )));

  const matrix: number[][] = vocab.map(() => new Array<number>(N).fill(0));
  docsTokens.forEach((toks, d) => {
    const tf = new Map<number, number>();
    for (const t of toks) {
      const ti = termIndex.get(t);
      if (ti !== undefined) tf.set(ti, (tf.get(ti) ?? 0) + 1);
    }
    const len = toks.length || 1;
    for (const [ti, c] of tf) matrix[ti][d] = (c / len) * idf[ti];
  });

  return { vocab, termIndex, idf, matrix };
}

/** Project a query's tokens into the TF-IDF term space (a terms-length vector). */
export function queryVector(tf: Tfidf, tokens: string[]): number[] {
  const v = new Array<number>(tf.vocab.length).fill(0);
  const counts = new Map<number, number>();
  for (const t of tokens) {
    const ti = tf.termIndex.get(t);
    if (ti !== undefined) counts.set(ti, (counts.get(ti) ?? 0) + 1);
  }
  const len = tokens.length || 1;
  for (const [ti, c] of counts) v[ti] = (c / len) * tf.idf[ti];
  return v;
}
