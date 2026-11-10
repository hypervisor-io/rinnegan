import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GraphStore, basicTokens } from "../graph/store.js";
import type { GraphNode } from "../core/types.js";
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
  /** Restrict the slice to nodes whose filePath is in this set (see `--scope`). */
  scopeFiles?: Set<string>;
}

export interface UnderstandResult {
  text: string;
  facts: RenderedFact[];
  tokensEstimate: number;
  anchors: string[];
}

const LEGEND =
  "# Legend: [ast_exact]=ground truth · [ast_inferred]/[heuristic]/[latent]=labeled, verify · [unresolved]=static path ends here. Cite file:line.";

/** Definition-level kinds are the only sane anchors; bindings/fields are noise. */
const DEF_ANCHOR_KINDS = new Set<string>([
  "function", "method", "class", "interface", "struct", "type_alias", "enum", "module",
]);

/** Function words that must not buy a coverage anchor slot. */
const ANCHOR_STOPWORDS = new Set([
  "the", "and", "for", "how", "does", "did", "was", "were", "what", "when", "where", "why",
  "with", "this", "that", "into", "from", "about", "are", "can", "its", "not", "via", "use",
  "used", "using", "work", "works", "working",
]);

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

  const roles = store.roleByFile();
  const testIntent = /\b(test|spec|coverage)s?\b/i.test(task);
  // Seed-quality policy. Blind A/B judging showed two capture modes that make a
  // slice useless no matter how good the ranking is:
  //   1. test harnesses (lexically loud, never the answer to a production task),
  //   2. sub-symbols of files (Mock.a, Page.header, const.ctrl) — bindings and
  //      fields whose "names" are one letter or a Vue lifecycle hook.
  // Anchors therefore prefer definition-kind symbols in non-test, non-doc files.
  // If that filter starves the pool, widen it, then progressively relax.
  const isTestFile = (n?: GraphNode) => !!n && roles.get(n.filePath) === "test";
  const isDocFile = (n?: GraphNode) => !!n && roles.get(n.filePath) === "doc";
  const isDef = (n?: GraphNode) => !!n && DEF_ANCHOR_KINDS.has(n.kind);
  const pick = (ids: string[], accept: (n?: GraphNode) => boolean): string[] =>
    ids.filter((id) => accept(store.getNode(id)));
  const anchorTiers: Array<(n?: GraphNode) => boolean> = testIntent
    ? [() => true]
    : [
        (n) => isDef(n) && !isTestFile(n) && !isDocFile(n),
        (n) => !isTestFile(n) && !isDocFile(n),
        (n) => !isTestFile(n),
        () => true,
      ];
  if (anchors.length > 0) {
    const widened = semantic.seed(task, seedLimit * 6).map((s) => s.id);
    let chosen: string[] = [];
    for (let i = 0; i < anchorTiers.length; i++) {
      const pool = i < 3 ? widened : anchors; // first tiers widen, last accepts what we had
      const ids = pick(pool, anchorTiers[i]).slice(0, seedLimit);
      if (ids.length > 0) { chosen = ids; break; }
    }
    if (chosen.length > 0) anchors = chosen;
  }

  // Query-term coverage: latent/BM25 seeding over-rewards common words ("user"
  // fills every slot) and starves rare, decisive tokens ("vnc" → novnc/vncAction).
  // Guarantee each distinct query token one anchor (whole-token FTS first, then
  // the substring pass), and treat those anchors as strong matches later.
  const coverageAnchors: string[] = [];
  if (anchors.length > 0) {
    const acceptable = (n: GraphNode) =>
      DEF_ANCHOR_KINDS.has(n.kind) && !isTestFile(n) && !isDocFile(n);
    const taskTokens = [...new Set(basicTokens(task))].filter(
      (t) => t.length >= 3 && !ANCHOR_STOPWORDS.has(t),
    );
    for (const t of taskTokens) {
      const candidates = [
        ...store.searchFts(t, 25),
        ...store.searchTokensSubstring([t], 25),
      ].filter(acceptable);
      if (candidates.length === 0) continue;
      // Among equally valid lexical hits, prefer the file whose path speaks the
      // rest of the task ("user panel VNC…" → User/.../noVNC over Admin/...).
      let best = candidates[0];
      let bestHits = -1;
      for (const n of candidates) {
        const path = n.filePath.toLowerCase();
        const hits = taskTokens.filter((x) => x !== t && path.includes(x)).length;
        if (hits > bestHits) { best = n; bestHits = hits; }
      }
      coverageAnchors.push(best.id);
      if (coverageAnchors.length >= 6) break;
    }
    if (coverageAnchors.length > 0) anchors = [...new Set([...anchors, ...coverageAnchors])];
  }

  const scopeFiles = opts.scopeFiles;
  const inScope = scopeFiles ? (n: GraphNode) => scopeFiles.has(n.filePath) : undefined;
  if (inScope) {
    anchors = anchors.filter((id) => {
      const n = store.getNode(id);
      return !!n && inScope(n);
    });
  }

  const spine = extractSpine(store, anchors, { depth, maxNodes, include: inScope });
  const relevance = semantic.relevance(task);
  // Coverage anchors matched a distinct query token directly — treat them as
  // strong for this task even when latent/BM25 mass sits on common words.
  for (const id of coverageAnchors) {
    relevance.set(id, Math.max(relevance.get(id) ?? 0, 0.7));
  }
  const rankedAll = rankNodes(store, spine, relevance, { roles, testIntent, seedIds: new Set(anchors) });
  const nonTest = rankedAll.filter((r) => !isTestFile(r.node));
  const ranked = !testIntent && nonTest.length > 0 ? nonTest : rankedAll;

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
    const h = buildHarmonic(store, ranked, readSource, { tokenBudget: inner, balance: opts.balance, roles });
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
