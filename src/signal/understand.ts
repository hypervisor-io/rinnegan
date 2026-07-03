import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GraphStore } from "../graph/store.js";
import { SemanticEngine } from "../semantic/engine.js";
import { extractSpine } from "./spine.js";
import { rankNodes } from "./rank.js";
import { estimateTokens, positionOrder } from "./budget.js";
import { renderFact, type RenderedFact } from "./render.js";
import { buildHarmonic, type Balance } from "./harmonic.js";

export interface UnderstandOpts {
  root: string;
  tokenBudget?: number;
  seedLimit?: number;
  depth?: number;
  maxNodes?: number;
  fullCount?: number;
  /** "harmonic" (default): MAP→SIGNATURES→DETAIL tiers. "flat": detail only. */
  resolution?: "harmonic" | "flat";
  balance?: Balance;
}

export interface UnderstandResult {
  text: string;
  facts: RenderedFact[];
  tokensEstimate: number;
  anchors: string[];
}

const LEGEND =
  "# Legend: [ast_exact]=ground truth · [ast_inferred]/[heuristic]/[latent]=labeled, verify · [unresolved]=static path ends here. Cite file:line.";

/**
 * The signal engine: task → minimal, provenance-tagged, position-ordered,
 * whitespace-minimized slice. Sized to leave a 1M window almost entirely free.
 */
export function understand(
  store: GraphStore,
  semantic: SemanticEngine,
  task: string,
  opts: UnderstandOpts,
): UnderstandResult {
  const tokenBudget = opts.tokenBudget ?? 6000;
  const seedLimit = opts.seedLimit ?? 8;
  const depth = opts.depth ?? 2;
  const maxNodes = opts.maxNodes ?? 60;
  const fullCount = opts.fullCount ?? 12;

  let anchors = semantic.seed(task, seedLimit).map((s) => s.id);
  if (anchors.length === 0) anchors = store.searchFts(task, seedLimit).map((n) => n.id);

  const spine = extractSpine(store, anchors, { depth, maxNodes });
  const relevance = semantic.relevance(task);
  const testIntent = /\b(test|spec|coverage)s?\b/i.test(task);
  const ranked = rankNodes(store, spine, relevance, { roles: store.roleByFile(), testIntent });

  const fileCache = new Map<string, string | undefined>();
  const readSource = (path: string): string | undefined => {
    if (fileCache.has(path)) return fileCache.get(path);
    let src: string | undefined;
    try {
      src = readFileSync(join(opts.root, path), "utf8");
    } catch {
      src = undefined;
    }
    fileCache.set(path, src);
    return src;
  };

  // Harmonic multi-resolution memory (default): MAP → SIGNATURES → DETAIL.
  if ((opts.resolution ?? "harmonic") === "harmonic") {
    const header = [`# Rinnegan slice for: ${task}`, LEGEND, ""].join("\n");
    const inner = Math.max(200, tokenBudget - estimateTokens(header) - 30); // reserve fixed overhead
    const h = buildHarmonic(store, ranked, readSource, { tokenBudget: inner, balance: opts.balance });
    const text = [header, h.text].join("\n");
    return { text, facts: h.facts, tokensEstimate: estimateTokens(text), anchors };
  }

  // Greedy budgeted selection (best-first). Top `fullCount` get full source; rest skeleton.
  const selected: RenderedFact[] = [];
  let used = estimateTokens(LEGEND) + estimateTokens(`# Rinnegan slice for: ${task}`);
  ranked.forEach((r, i) => {
    const skeleton = i >= fullCount;
    const src = skeleton ? undefined : readSource(r.node.filePath);
    const fact = renderFact(store, r, src, { skeleton });
    const cost = estimateTokens(fact.body);
    if (used + cost > tokenBudget && selected.length > 0) return;
    selected.push(fact);
    used += cost;
  });

  const ordered = positionOrder(selected);
  const text = [
    `# Rinnegan slice for: ${task}`,
    LEGEND,
    "",
    ...ordered.map((f) => f.body),
  ].join("\n");

  return { text, facts: ordered, tokensEstimate: estimateTokens(text), anchors };
}
