import type { GraphNode, NodeKind } from "../core/types.js";
import { Bm25Index } from "../semantic/bm25.js";

/**
 * Kinds whose own source is worth reading. A `variable`/`constant`/`property`
 * body is a one-line initializer (or nothing), so it carries no “how does this
 * work” signal — the file-level prior already covers it.
 */
export const BODY_KINDS = new Set<NodeKind>([
  "function", "method", "class", "interface", "struct", "type_alias", "enum", "module",
]);

/**
 * Deterministic cap on one symbol's body, in source characters (≈8k tokens at
 * this codebase's 4-chars-per-token estimate). A generated 6k-line method must
 * not dominate the cost of a query, and truncating at a fixed character count
 * keeps the token stream — and therefore the score — byte-identical run to run.
 */
export const BODY_CHAR_CAP = 32_000;

/**
 * Largest span (source lines) that may earn a body boost.
 *
 * Two measured failure modes set this: a 400-line `main()` or a 600-line
 * evaluator mentions every query word somewhere, so a body prior that promotes
 * it spends its one boost on a fact too big for the DETAIL tier — truncating the
 * whole specificity tier; and a Ruby `module ActiveRecord` that wraps an entire
 * file IS the file, so scoring it just applies the file prior twice. Past this
 * size the body is a file section, not a symbol: the body prior is for choosing
 * among the symbols INSIDE a file.
 */
export const BODY_SPAN_LINES = 200;

/**
 * Per-symbol body relevance: BM25 over each candidate's OWN source body, in the
 * already-bounded candidate pool, normalized so the best-matching body is 1.
 *
 * Why this exists: the file-level prior can only say “this file is about the
 * task”. Inside it every symbol then looks alike, so the ranker picks by node id
 * and a file's DETAIL slots can go to accessors that repeat the query word
 * instead of the code that does the work. Scoring each body lets the ranker
 * choose within the file — measured on the five-corpus eval, this is what brings
 * promql/engine.go's `eval` pipeline (NewInstantQuery, execEvalStmt, eval, and
 * the promqltest harness that drives them) up for "how does PromQL evaluate an
 * instant query", where names alone only reach promtool's CLI helpers.
 *
 * `readSource` is the caller's cache (one read per file, missing file ⇒
 * `undefined` ⇒ that body is simply absent, never an error).
 *
 * Determinism: candidates are sorted by (filePath, startLine, id) before the
 * index is built, so identical inputs give an identical map.
 */
export function bodyRelevance(
  task: string,
  nodes: GraphNode[],
  readSource: (path: string) => string | undefined,
): Map<string, number> {
  const eligible = nodes
    .filter((n) => BODY_KINDS.has(n.kind) && n.endLine >= n.startLine)
    .sort((a, b) =>
      a.filePath !== b.filePath
        ? a.filePath < b.filePath ? -1 : 1
        : a.startLine - b.startLine || (a.id < b.id ? -1 : 1),
    );
  if (eligible.length === 0) return new Map();

  const docs: { id: string; text: string }[] = [];
  // Split each file's source ONCE — a big file contributes many candidates, and
  // re-splitting its bytes per candidate is O(nodes × file size) for no gain.
  const linesByFile = new Map<string, string[] | null>();
  for (const n of eligible) {
    let lines = linesByFile.get(n.filePath);
    if (lines === undefined) {
      const src = readSource(n.filePath);
      lines = src === undefined ? null : src.split("\n"); // unreadable/missing ⇒ no body, no throw
      linesByFile.set(n.filePath, lines);
    }
    if (lines === null) continue;
    // A giant body is a file section, not a symbol signal: it cannot be rendered
    // inside DETAIL, and BM25 over it would just mirror the file prior.
    if (n.endLine - n.startLine + 1 > BODY_SPAN_LINES) continue;
    const from = Math.max(0, n.startLine - 1);
    const to = Math.min(lines.length, n.endLine);
    if (to <= from) continue;
    let body = lines.slice(from, to).join("\n");
    if (body.length > BODY_CHAR_CAP) body = body.slice(0, BODY_CHAR_CAP);
    // Name + signature + docstring first — a body alone repeats `m`/`err`/`if`
    // and would score every long method alike.
    docs.push({ id: n.id, text: `${n.qualifiedName} ${n.signature ?? ""} ${n.docstring ?? ""} ${body}` });
  }
  if (docs.length === 0) return new Map();

  const hits = new Bm25Index(docs).search(task, docs.length);
  if (hits.length === 0) return new Map();
  const max = hits[0].score;
  if (max <= 0) return new Map();
  return new Map(hits.map((h) => [h.id, h.score / max]));
}
