/**
 * Conservative, deterministic CODE-IDENTIFIER morphology.
 *
 * Tasks are asked in prose ("how does PromQL evaluate an instant query") while
 * the graph stores identifiers ("eval", "rangeEval", "execEvalStmt"). Exact
 * token matching therefore loses the very symbol the task names. This module
 * derives a *small* set of extra forms per token so a query term can meet its
 * identifiers' inflection, without a stemmer that merges unrelated words or a
 * corpus-derived vocabulary that would make the index non-deterministic.
 *
 * Two mechanisms, both corpus-independent:
 *   1. a curated map of common programming verbs (evaluate → eval, registration
 *      → register, …) — the cases suffix rules get wrong;
 *   2. a deliberately narrow suffix rule ("ing", "ed", trailing "s") that only
 *      fires on tokens long enough to leave a ≥4-char stem, so "string" never
 *      becomes "str" and "runs" never becomes something else.
 *
 * The RAW token is always kept by the caller; variants are additive, so no
 * existing exact match can regress.
 */

/** Canonical programming-verb forms. Keys and values are already-lowercase tokens. */
const CANONICAL: Record<string, string> = {
  // evaluate / evaluation
  evaluate: "eval", evaluated: "eval", evaluates: "eval", evaluating: "eval",
  evaluation: "eval", evaluations: "eval",
  // run
  running: "run", runs: "run",
  // register
  registered: "register", registers: "register", registering: "register",
  registration: "register", registrations: "register",
  // route
  routed: "route", routes: "route", routing: "route",
  // collect
  collected: "collect", collects: "collect", collecting: "collect",
  collection: "collect", collections: "collect", collector: "collect", collectors: "collect",
  // common neighbours (query ⇄ identifier)
  parsing: "parse", parsed: "parse", parses: "parse",
  scheduling: "schedule", scheduled: "schedule", scheduler: "schedule",
  dispatching: "dispatch", dispatched: "dispatch", dispatcher: "dispatch",
  resolving: "resolve", resolved: "resolve", resolver: "resolve",
  rendering: "render", rendered: "render",
  encoding: "encode", encoded: "encode",
  decoding: "decode", decoded: "decode",
  validate: "validate", validated: "validate", validating: "validate", validation: "validate",
  initializing: "init", initialize: "init", initialization: "init",
};

/** Suffixes stripped by the general rule, longest first. */
const SUFFIXES: ReadonlyArray<{ suffix: string; minToken: number; minStem: number }> = [
  { suffix: "ing", minToken: 6, minStem: 4 },
  { suffix: "ed", minToken: 6, minStem: 4 },
  { suffix: "s", minToken: 5, minStem: 4 },
];

/** True when `t` is a plain lowercase ASCII identifier token (what basicTokens emits). */
function isPlain(t: string): boolean {
  return /^[a-z][a-z0-9]*$/.test(t);
}

/**
 * The canonical form of one token, or the token itself when no rule applies.
 * Never shortens a token below 4 characters, so short words stay themselves.
 */
export function lemma(token: string): string {
  if (!isPlain(token)) return token;
  if (Object.hasOwn(CANONICAL, token)) return CANONICAL[token];
  for (const { suffix, minToken, minStem } of SUFFIXES) {
    if (token.length < minToken || !token.endsWith(suffix)) continue;
    let stem = token.slice(0, -suffix.length);
    // "embedded" would leave "embedd" — collapse the doubled consonant ("runn" → "run").
    if (stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2]) stem = stem.slice(0, -1);
    if (stem.length >= minStem) return stem;
  }
  return token;
}

/**
 * Extra forms for one token (never the token itself). Empty when no rule fires,
 * which keeps the FTS documents small for ordinary code tokens.
 */
export function morphVariants(token: string): string[] {
  const l = lemma(token);
  return l !== token ? [l] : [];
}

/**
 * Expand a token list with its morphological variants, preserving document order
 * and term frequency: every input token is emitted, immediately followed by its
 * extra forms. Deterministic; duplicates are intentional (they are the tf signal).
 */
export function expandMorphology(tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    out.push(t);
    for (const v of morphVariants(t)) out.push(v);
  }
  return out;
}

/**
 * Compact word forms: the word itself, lowercased. Camel-case splitting is a
 * property of an IDENTIFIER, but the same concept is often written as one word
 * elsewhere — "PromQL" in a question, "promql" in a package/file path — so the
 * unsplit lowercase run is indexed as well as the split pieces. Only words that
 * survive `[a-z0-9]+` intact qualify: punctuation never merges two words into
 * one.
 */
export function compactVariants(text: string): string[] {
  const out: string[] = [];
  for (const word of text.split(/[^A-Za-z0-9_]+/)) {
    if (!word) continue;
    const compact = word.toLowerCase();
    if (compact.length >= 3 && isPlain(compact)) out.push(compact);
  }
  return out;
}

/** Split one identifier-ish word on camelCase boundaries and separators. */
function splitWord(word: string): string[] {
  return word
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/**
 * The concept words of a free-text query, one entry per word the caller wrote.
 *
 * Camel-case splitting is a property of the IDENTIFIER, not of the question: a
 * caller who writes "PromQL" means one word, but the generic splitter also emits
 * "prom" and "ql", which then match unrelated identifiers and consume the
 * per-token anchor budget. So a camel-compound word with an intact compact form
 * contributes that compact form only; every other word keeps its normal tokens.
 * Deterministic, order-preserving, and it never merges two words into one.
 */
export function queryConcepts(text: string): string[] {
  const out: string[] = [];
  for (const word of text.split(/[^A-Za-z0-9_]+/)) {
    if (!word) continue;
    const compact = word.toLowerCase();
    // A camelCase/digit boundary AND the word survives as one plain lowercase token.
    const compound = compact !== word && /[a-z0-9][A-Z]/.test(word) && isPlain(compact);
    if (compound && compact.length >= 3) out.push(compact);
    else out.push(...splitWord(word));
  }
  return out;
}
