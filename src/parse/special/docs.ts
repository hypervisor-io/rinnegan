import { dirname, join, normalize } from "node:path";
import { nodeId } from "../../core/types.js";
import type { GraphNode, GraphEdge } from "../../core/types.js";
import type { ParseResult } from "../extract.js";

/**
 * Docs extractor: markdown `[text](./other.md)` links and `[[wikilinks]]` become
 * `references` edges between documents — so docs join the same knowledge graph.
 */
export function extractDocs(path: string, source: string, language: string): ParseResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const lines = source.split("\n");

  const fileId = nodeId(path, "<file>");
  nodes.push({ id: fileId, kind: "file", qualifiedName: "<file>", filePath: path, language, startLine: 1, endLine: lines.length });

  const linkRe = /\[[^\]]*\]\(([^)\s]+)\)/g;
  const wikiRe = /\[\[([^\]]+)\]\]/g;
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    linkRe.lastIndex = 0;
    while ((m = linkRe.exec(line))) {
      const target = m[1];
      if (/^(https?:|#|mailto:|\/\/)/.test(target)) continue;
      const clean = target.split("#")[0];
      if (!clean) continue;
      const resolved = normalize(join(dirname(path), clean));
      const tid = nodeId(resolved, "<file>");
      const key = `l:${tid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: fileId, target: tid, kind: "references", line: i + 1, col: 1, provenance: "ast_exact", confidence: 1, resolver: "docs-link", metadata: { doc: true, target: resolved } });
    }
    wikiRe.lastIndex = 0;
    while ((m = wikiRe.exec(line))) {
      const name = m[1].split("|")[0].trim();
      if (!name) continue;
      const tid = nodeId("<wiki>", name);
      if (!seen.has(`w:${name}`)) {
        seen.add(`w:${name}`);
        nodes.push({ id: tid, kind: "unresolved", qualifiedName: `<wiki>.${name}`, filePath: path, language, startLine: i + 1, endLine: i + 1 });
      }
      edges.push({ source: fileId, target: tid, kind: "references", line: i + 1, col: 1, provenance: "heuristic", confidence: 0.5, resolver: "docs-wiki" });
    }
  }

  return { nodes, edges, unresolved: 0, imports: [] };
}
