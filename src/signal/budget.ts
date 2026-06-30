/** ~4 chars per token is a stable, model-agnostic estimate. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Position-aware ordering: place the highest-signal items at the context EDGES
 * (primacy + recency) and the lowest in the middle — directly countering the
 * "lost in the middle" degradation. Input must be sorted best-first.
 */
export function positionOrder<T>(items: T[]): T[] {
  const out = new Array<T>(items.length);
  let lo = 0;
  let hi = items.length - 1;
  items.forEach((it, i) => {
    if (i % 2 === 0) out[lo++] = it;
    else out[hi--] = it;
  });
  return out;
}
