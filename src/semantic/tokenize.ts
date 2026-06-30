/**
 * Identifier-aware tokenization with a small curated programming-synonym lexicon.
 * Deterministic, no model. Used to build symbol documents for LSA + BM25.
 */

const SYNONYMS: Record<string, string[]> = {
  auth: ["authenticate", "authentication", "login", "signin", "credential"],
  login: ["auth", "authenticate", "signin", "session"],
  logout: ["signout", "session"],
  delete: ["remove", "destroy", "rm", "drop"],
  remove: ["delete", "destroy", "rm"],
  create: ["add", "new", "make", "insert"],
  update: ["edit", "modify", "patch", "set"],
  fetch: ["get", "load", "retrieve", "query", "read"],
  user: ["account", "member", "profile"],
  config: ["configuration", "settings", "options"],
  error: ["err", "fail", "failure", "exception"],
  validate: ["check", "verify", "assert"],
  parse: ["decode", "read", "extract"],
  render: ["draw", "paint", "display"],
};

const STOP = new Set(["the", "and", "for", "this", "that", "with", "from", "into", "return", "const", "let", "var", "function"]);

/** Split camelCase / snake_case / dotted identifiers into lowercase word tokens. */
export function splitIdentifier(s: string): string[] {
  if (!s) return [];
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[._/\\:#<>(){}\[\],;'"`=+*&|!?~^%$@-]+/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Expand a token list with curated synonyms (does not duplicate existing tokens). */
export function expandSynonyms(tokens: string[]): string[] {
  const out = new Set(tokens);
  for (const t of tokens) {
    // own-property guard: tokens like "constructor"/"toString" must not hit the prototype
    const syns = Object.hasOwn(SYNONYMS, t) ? SYNONYMS[t] : [];
    for (const syn of syns) out.add(syn);
  }
  return [...out];
}

/** Full document tokenization: split + synonym-expand. */
export function docTokens(text: string): string[] {
  return expandSynonyms(splitIdentifier(text));
}
