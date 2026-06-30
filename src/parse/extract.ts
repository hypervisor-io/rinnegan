import type { GraphNode, GraphEdge } from "../core/types.js";
import { extractTypeScript } from "./lang/typescript.js";

export interface ParseResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolved: number;
}

/**
 * Parse one file into provenance-tagged nodes + edges.
 * TypeScript/JavaScript use the TS compiler AST (precise, deterministic).
 * Other languages plug in here in Phase 5.
 */
export async function parseFile(
  path: string,
  source: string,
  language: string,
): Promise<ParseResult> {
  switch (language) {
    case "typescript":
    case "javascript":
      return extractTypeScript(path, source, language);
    default:
      return { nodes: [], edges: [], unresolved: 0 };
  }
}
