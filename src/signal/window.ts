import type { GraphStore } from "../graph/store.js";
import { WINDOW_MAX } from "../graph/store.js";
import type { GraphNode } from "../core/types.js";
import { BODY_KINDS } from "./body.js";

/**
 * Per-symbol WINDOW relevance: BM25 over the indexed BODY WINDOWS a candidate
 * overlaps, normalized so the best-matching chunk is 1.
 *
 * Why a second, index-side prior on top of `bodyRelevance`:
 *
 *  - `bodyRelevance` reads the candidate's own source and skips anything the
 *    body caps exclude (>200 lines, >32 kB). Those are exactly the symbols in a
 *    large implementation file — the ones a task about that file wants.
 *  - A symbol can be right next to the evidence and still say nothing itself
 *    ("execEvalStmt" is generic; the `eval` loop below it carries the task's
 *    vocabulary). The window index already holds that neighbourhood, positionally
 *    keyed by source line, so nothing has to be read again at query time.
 *
 * The window rows and their line ranges are written by the indexer
 * (`GraphStore.setFileTokens` → `bodyWindows`), and windows tile every file
 * contiguously, so the intersection test below always finds a chunk for a symbol
 * in an indexed file.
 *
 * Only the BEST intersecting chunk counts, and it is scored on the chunk's BODY
 * alone (path weight 0): the path already earned the whole file its own prior,
 * and re-counting it here would let one file's path dominate the symbol choice
 * inside it.
 *
 * Determinism: candidates and windows are ordered by (file, startLine, id), so
 * identical inputs give an identical map.
 */
export function windowRelevance(
  store: GraphStore,
  task: string,
  nodes: GraphNode[],
): Map<string, number> {
  const candidates = nodes
    .filter((n) => BODY_KINDS.has(n.kind) && n.endLine >= n.startLine)
    .sort((a, b) =>
      a.filePath !== b.filePath
        ? a.filePath < b.filePath ? -1 : 1
        : a.startLine - b.startLine || (a.id < b.id ? -1 : 1),
    );
  if (candidates.length === 0) return new Map();

  const files = [...new Set(candidates.map((n) => n.filePath))].sort();
  // A file contributes at most WINDOW_MAX rows, so this bound always covers the
  // windows of every candidate file that has any evidence at all.
  const windows = store.windowScores(task, files.length * WINDOW_MAX, 0);
  if (windows.length === 0) return new Map();

  const byFile = new Map<string, { startLine: number; endLine: number; score: number }[]>();
  for (const w of windows) {
    const list = byFile.get(w.file);
    if (list) list.push(w);
    else byFile.set(w.file, [w]);
  }

  const scored: { id: string; score: number }[] = [];
  for (const n of candidates) {
    // Windows were filtered to files with evidence, so an unmatched file is a miss.
    const list = byFile.get(n.filePath);
    if (!list) continue;
    let best: number | undefined;
    for (const w of list) {
      if (w.startLine > n.endLine || w.endLine < n.startLine) continue; // no overlap
      if (best === undefined || w.score > best) best = w.score;
    }
    if (best !== undefined) scored.push({ id: n.id, score: best });
  }
  if (scored.length === 0) return new Map();

  let max = 0;
  for (const s of scored) max = Math.max(max, s.score);
  if (max <= 0) return new Map();
  return new Map(scored.map((s) => [s.id, s.score / max]));
}
