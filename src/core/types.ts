import { createHash } from "node:crypto";

export type NodeKind =
  | "file" | "module" | "class" | "struct" | "interface" | "function"
  | "method" | "property" | "field" | "variable" | "constant" | "enum"
  | "enum_member" | "type_alias" | "import" | "export" | "unresolved";

export type EdgeKind =
  | "contains" | "calls" | "imports" | "exports" | "extends" | "implements"
  | "references" | "type_of" | "returns" | "instantiates" | "overrides" | "decorates";

/**
 * Provenance is the heart of Veridex: every edge declares HOW it was derived,
 * so an agent never mistakes a guess for ground truth.
 */
export type Provenance =
  | "ast_exact"     // directly from the AST, unambiguous resolution — the only ground truth
  | "ast_inferred"  // AST-derived but required an inference step (e.g. supertype walk)
  | "lexical"       // produced by lexical (BM25) discovery
  | "latent"        // produced by latent-semantic (LSA) discovery
  | "heuristic"     // pattern-synthesized (observer/callback/dispatch)
  | "unresolved";   // boundary — the static path ends here

export type ReadWrite = "read" | "write" | "readwrite" | "call" | "addr" | "none";

/** Trust weight per provenance class. Used by the signal ranker. */
export const PROVENANCE_TRUST: Record<Provenance, number> = {
  ast_exact: 1,
  ast_inferred: 0.8,
  heuristic: 0.5,
  lexical: 0.3,
  latent: 0.3,
  unresolved: 0,
};

export interface GraphNode {
  id: string;
  kind: NodeKind;
  qualifiedName: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  signature?: string;
  docstring?: string;
  isExported?: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  line: number;
  col: number;
  provenance: Provenance;
  confidence: number;
  resolver: string;
  readWrite?: ReadWrite;
  metadata?: Record<string, unknown>;
}

/** Deterministic, stable node id from file path + qualified name. */
export function nodeId(filePath: string, qualifiedName: string): string {
  return createHash("sha256")
    .update(`${filePath}::${qualifiedName}`)
    .digest("hex")
    .slice(0, 24);
}
