import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GraphStore } from "../graph/store.js";
import { queryConcepts, lemma } from "../semantic/morph.js";
import type { GraphNode } from "../core/types.js";
import { SemanticEngine } from "../semantic/engine.js";
import { extractSpine } from "./spine.js";
import { rankNodes, type Ranked } from "./rank.js";
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
 * Full-file body+path prior → ranking pool. At most this many best-scoring
 * files contribute their definition symbols, and only at or above this
 * normalized score (1 = the single best file for the task). Six (not three) is
 * deliberate: the measured misses showed the implementing file sitting 4th-6th
 * behind same-language neighbours (a metrics collector, a CLI), and a candidate
 * that never enters the pool can never be ranked. Prior files only ADD
 * candidates — they never seed anchors, and the ranker still decides.
 */
const FILE_PRIOR_FILES = 6;
const FILE_PRIOR_MIN = 0.5;

/**
 * Same-file coherence: how many definition symbols the 1st and 2nd prior files
 * contribute as a block, and how many prior files get such a block.
 *
 * Ranking can only order the pool; a big implementation file's constructor or
 * entry method can sit below the DETAIL budget cut behind a dozen same-scored
 * siblings (measured: tokio's `Driver::new` ranked 21st in its own pool while
 * its file was the clear #1 prior). Seating the file's best-ranked definitions
 * as one block — after the file's first symbol, never ahead of a better-ranked
 * one from another file — puts the file's *shape* in play without demoting the
 * existing high-scored anchors.
 */
const COHERENCE_PER_FILE = 5;
const COHERENCE_FILES = 2;

/**
 * Reseat `ranked` so each of the top `files` prior files carries its
 * `COHERENCE_PER_FILE` best-ranked definitions as one contiguous block,
 * anchored right after that file's first ranked symbol.
 *
 * Order within the block: score DESC, then source line ASC — so tied siblings
 * come back in the order a reader meets them in the file, not in id order.
 * Definitions already present keep exactly one slot (deterministic, no dupes).
 *
 * Exported for the regression tests that pin the block order.
 */
export function sameFileCoherence(
  ranked: Ranked[],
  priorFiles: string[],
  defKinds: Set<string>,
): Ranked[] {
  if (priorFiles.length === 0) return ranked;

  const blocks = new Map<string, Ranked[]>();
  for (const file of priorFiles) {
    const defs = ranked
      .filter((r) => r.node.filePath === file && defKinds.has(r.node.kind))
      .sort((a, b) => b.score - a.score || a.node.startLine - b.node.startLine || (a.node.id < b.node.id ? -1 : 1))
      .slice(0, COHERENCE_PER_FILE);
    if (defs.length > 1) blocks.set(file, defs);
  }
  if (blocks.size === 0) return ranked;

  const served = new Set<string>();
  const out: Ranked[] = [];
  for (const r of ranked) {
    if (served.has(r.node.id)) continue;
    out.push(r);
    served.add(r.node.id);
    const block = blocks.get(r.node.filePath);
    if (!block) continue;
    for (const c of block) {
      if (served.has(c.node.id)) continue;
      out.push(c);
      served.add(c.node.id);
    }
  }
  return out;
}

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
  // Tokens come from `queryConcepts`, not the raw splitter: a caller who writes
  // "PromQL" means one concept, and must not spend two anchor slots on "prom"
  // and "ql" (which then match unrelated identifiers).
  const fileRelevance = store.fileRelevance(task);
  const coverageAnchors: string[] = [];
  const wholeAnchorIds = new Set<string>();
  const exactAnchors = new Set<string>();
  if (anchors.length > 0) {
    const acceptable = (n: GraphNode) =>
      DEF_ANCHOR_KINDS.has(n.kind) && !isTestFile(n) && !isDocFile(n);
    const taskTokens = [...new Set(queryConcepts(task))].filter(
      (t) => t.length >= 3 && !ANCHOR_STOPWORDS.has(t),
    );
    for (const t of taskTokens) {
      // Wide enough that `unresolved` call-site placeholders (short documents
      // that match a one-word name) cannot crowd the real definitions out of
      // the window before the kind filter below runs.
      const whole = store.searchFts(t, 240).filter(acceptable);
      const substrings = store.searchTokensSubstring([t], 240).filter(acceptable);
      const candidates = [...whole, ...substrings];
      if (candidates.length === 0) continue;
      // A whole-token hit is the symbol's own vocabulary; a substring-only hit
      // ("drive" inside `driver::Handle`) merely tells us which neighbourhood to
      // look at, so it may seed the spine but never claims relevance on its own.
      const wholeIds = new Set(whole.map((n) => n.id));
      // Among equally valid lexical hits prefer, in order: the symbol whose NAME
      // is the concept (exact or its lemma — `eval` for "evaluate"), then the
      // file that speaks the rest of the task (its PATH holds the other
      // concepts: "user panel VNC…" → User/.../noVNC over Admin/...), then the
      // file-level prior (the file whose path/body is most about the task is
      // where the concept lives).
      const wanted = new Set([t, lemma(t)]);
      let best = candidates[0];
      let bestKey: [number, number, number] = [-1, -1, -1];
      for (const n of candidates) {
        const name = (n.qualifiedName.split(".").pop() ?? "").toLowerCase();
        const exact = wanted.has(name) ? 1 : 0;
        const hits = taskTokens.filter((x) => x !== t && n.filePath.toLowerCase().includes(x)).length;
        const key: [number, number, number] = [exact, hits, fileRelevance.get(n.filePath) ?? 0];
        const better =
          key[0] > bestKey[0] ||
          (key[0] === bestKey[0] && (key[1] > bestKey[1] || (key[1] === bestKey[1] && key[2] > bestKey[2])));
        if (better) {
          best = n;
          bestKey = key;
        }
      }
      coverageAnchors.push(best.id);
      if (wholeIds.has(best.id)) wholeAnchorIds.add(best.id);
      if (wholeIds.has(best.id) && bestKey[0] === 1) exactAnchors.add(best.id); // the symbol IS the concept
      if (coverageAnchors.length >= 8) break;
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
  // The body prior is a RANKER input, but ranking can only reorder what the
  // spine already contains — and on some corpora the spine provably cannot
  // reach the file that implements the concept: Rust extraction emits `calls`
  // edges only (no cross-file `references`), so tokio's driver.rs — the top
  // file by body BM25 for "…drive IO resources with epoll" — is unreachable
  // from any anchor. Seat the best prior files' definition symbols in the
  // ranking pool itself; anchors are untouched, so seeding stays lexical.
  const priorFiles = [...fileRelevance]
    .filter(([file, score]) => score >= FILE_PRIOR_MIN && roles.get(file) !== "test" && roles.get(file) !== "doc")
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, FILE_PRIOR_FILES)
    .map(([file]) => file);
  const pool = new Set(spine);
  for (const file of priorFiles) {
    if (scopeFiles && !scopeFiles.has(file)) continue;
    for (const n of store.nodesInFile(file)) {
      if (DEF_ANCHOR_KINDS.has(n.kind)) pool.add(n.id);
    }
  }
  const relevance = semantic.relevance(task);
  // Coverage anchors matched a distinct query token directly — treat them as
  // strong for this task even when latent/BM25 mass sits on common words. Only
  // whole-token matches earn the boost (a substring neighbour would hand a
  // random sibling the same weight); an anchor whose NAME is the concept
  // (`eval` for "evaluate") is the concept's own symbol and gets full weight.
  for (const id of coverageAnchors) {
    if (!wholeAnchorIds.has(id)) continue;
    const floor = exactAnchors.has(id) ? 1 : 0.7;
    relevance.set(id, Math.max(relevance.get(id) ?? 0, floor));
  }
  const rankedAll = rankNodes(store, pool, relevance, {
    roles, testIntent, seedIds: new Set(anchors), fileRelevance,
  });
  const nonTest = rankedAll.filter((r) => !isTestFile(r.node));
  const scored = !testIntent && nonTest.length > 0 ? nonTest : rankedAll;
  // Give the strongest prior files one coherent block of their own definitions,
  // so a file's entry symbol is not starved by its tied siblings.
  const ranked = testIntent
    ? scored
    : sameFileCoherence(scored, priorFiles.slice(0, COHERENCE_FILES), DEF_ANCHOR_KINDS);

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
