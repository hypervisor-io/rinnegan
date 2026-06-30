import type { GraphNode, GraphEdge } from "../core/types.js";
import { extractTypeScript } from "./lang/typescript.js";
import { extractTreeSitter, SPECS } from "./treesitter.js";
import { extractDocs } from "./special/docs.js";
import { extractManifest } from "./special/manifests.js";
import { extractMcp } from "./special/mcp_config.js";
import { extractElixir } from "./special/elixir.js";

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
    case "markdown":
      return extractDocs(path, source, language);
    case "manifest":
      return extractManifest(path, source, language);
    case "mcp":
      return extractMcp(path, source, language);
    case "elixir":
      return extractElixir(path, source, language);
    default:
      if (SPECS[language]) return extractTreeSitter(path, source, language, SPECS[language]);
      return { nodes: [], edges: [], unresolved: 0, imports: [] };
  }
}
