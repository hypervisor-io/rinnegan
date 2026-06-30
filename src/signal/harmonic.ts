import { GraphStore } from "../graph/store.js";
import type { Ranked } from "./rank.js";
import type { NodeKind } from "../core/types.js";
import { estimateTokens, positionOrder } from "./budget.js";
import { renderFact, type RenderedFact } from "./render.js";

/** Definition-level kinds — the only things that belong in the abstraction tiers. */
const DEF_KINDS = new Set<NodeKind>([
  "function", "method", "class", "interface", "struct", "type_alias", "enum", "module",
]);

export interface Balance {
  map: number;
  signatures: number;
  detail: number;
}

export const DEFAULT_BALANCE: Balance = { map: 0.15, signatures: 0.25, detail: 0.6 };

export interface HarmonicResult {
  text: string;
  facts: RenderedFact[];
}

/**
 * Harmonic multi-resolution memory — balances abstraction and specificity in one
 * budget, so an attention-limited model gets the SHAPE first and the exact lines
 * to edit last, with nothing in between to lose the thread on:
 *
 *   MAP        (max abstraction) — which files/symbols are in play, by file
 *   SIGNATURES (mid)             — one signature line per spine symbol
 *   DETAIL     (max specificity) — full, whitespace-minified bodies of the top-k
 *
 * Deterministic; no LLM summarization (that is cognee's bloat — we reject it).
 */
export function buildHarmonic(
  store: GraphStore,
  ranked: Ranked[],
  readSource: (path: string) => string | undefined,
  opts: { tokenBudget: number; balance?: Balance },
): HarmonicResult {
  const balance = opts.balance ?? DEFAULT_BALANCE;
  const mapBudget = opts.tokenBudget * balance.map;
  const sigBudget = opts.tokenBudget * balance.signatures;
  const detailBudget = opts.tokenBudget * balance.detail;

  const meaningful = ranked.filter((r) => r.node.kind !== "file");
  const defs = meaningful.filter((r) => DEF_KINDS.has(r.node.kind));
  // abstraction tiers use definitions; if a corpus has none, fall back to all
  const abstractionSet = defs.length > 0 ? defs : meaningful;

  // --- MAP: symbols grouped by file (orientation) ---
  const byFile = new Map<string, string[]>();
  for (const r of abstractionSet) {
    const list = byFile.get(r.node.filePath) ?? byFile.set(r.node.filePath, []).get(r.node.filePath)!;
    if (list.length < 8) list.push(r.node.qualifiedName.split(".").pop()!);
  }
  const mapLines: string[] = [];
  let mapUsed = 0;
  for (const [file, syms] of byFile) {
    const line = `  ${file}: ${syms.join(", ")}`;
    const c = estimateTokens(line);
    if (mapUsed + c > mapBudget && mapLines.length > 0) break;
    mapLines.push(line);
    mapUsed += c;
  }

  // --- SIGNATURES: one line per spine symbol (abstraction) ---
  const sigLines: string[] = [];
  let sigUsed = 0;
  for (const r of abstractionSet) {
    const sig = (r.node.signature ?? r.node.qualifiedName).trim();
    const line = `  ${r.node.filePath}:${r.node.startLine}  ${sig}`;
    const c = estimateTokens(line);
    if (sigUsed + c > sigBudget && sigLines.length > 0) break;
    sigLines.push(line);
    sigUsed += c;
  }

  // --- DETAIL: full bodies of the most relevant, position-ordered (specificity) ---
  const facts: RenderedFact[] = [];
  let detailUsed = 0;
  for (const r of meaningful) {
    const fact = renderFact(store, r, readSource(r.node.filePath), { skeleton: false });
    const c = estimateTokens(fact.body);
    if (detailUsed + c > detailBudget && facts.length > 0) break;
    facts.push(fact);
    detailUsed += c;
  }
  const ordered = positionOrder(facts);

  const text = [
    "# MAP (orientation — which symbols are in play)",
    ...mapLines,
    "",
    "# SIGNATURES (the spine at a glance)",
    ...sigLines,
    "",
    "# DETAIL (exact source to edit — provenance-tagged, whitespace-minified)",
    ...ordered.map((f) => f.body),
  ].join("\n");

  return { text, facts: ordered };
}
