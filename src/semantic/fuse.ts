import type { Scored } from "./lsa.js";

/**
 * Reciprocal Rank Fusion. Combines multiple ranked lists into one consensus
 * ranking via score = Σ 1/(k + rank). Robust to scale differences between
 * lexical (BM25) and latent (LSA) scores.
 */
export function rrfFuse(lists: Scored[][], k = 60): Scored[] {
  const agg = new Map<string, number>();
  for (const list of lists) {
    list.forEach((item, rank) => {
      agg.set(item.id, (agg.get(item.id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return [...agg.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
}
