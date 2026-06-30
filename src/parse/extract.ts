import type { GraphNode, GraphEdge } from "../core/types.js";
import { extractTypeScript } from "./lang/typescript.js";
import { extractTreeSitter, PYTHON_CONFIG, GO_CONFIG } from "./treesitter.js";

export interface ImportRef {
  localName: string;
  importedName: string; // exported name in the target module ("default", "*", or the symbol)
  moduleSpec: string;
  line: number;
}

export interface ParseResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolved: number;
  imports: ImportRef[];
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
    case "python":
      return extractTreeSitter(path, source, "python", PYTHON_CONFIG);
    case "go":
      return extractTreeSitter(path, source, "go", GO_CONFIG);
    default:
      return { nodes: [], edges: [], unresolved: 0, imports: [] };
  }
}
