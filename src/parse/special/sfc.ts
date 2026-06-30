import { nodeId } from "../../core/types.js";
import type { GraphNode, GraphEdge } from "../../core/types.js";
import type { ParseResult } from "../extract.js";
import { extractTypeScript } from "../lang/typescript.js";

/**
 * Single-File-Component extractor for Vue / Svelte / Astro. The component
 * markup carries no resolvable call graph, but the embedded <script> block is
 * ordinary JS/TS. We slice each <script> block out textually, parse it with the
 * precise TypeScript extractor, then shift every node/edge line number by the
 * block's offset so positions point back into the original .vue/.svelte/.astro
 * file. No SFC grammar is required, so the three formats share one code path.
 */

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

function scriptLanguage(attrs: string): string {
  return /lang\s*=\s*["'](ts|typescript)["']/i.test(attrs) ? "typescript" : "javascript";
}

export function extractSfc(path: string, source: string, language: string): ParseResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  let unresolved = 0;
  const seenNodes = new Set<string>();
  const fileId = nodeId(path, "<file>");

  // One file node spanning the whole component (replaces per-block file nodes).
  nodes.push({
    id: fileId, kind: "file", qualifiedName: "<file>", filePath: path, language,
    startLine: 1, endLine: source.split("\n").length,
  });
  seenNodes.add(fileId);

  for (const m of source.matchAll(SCRIPT_RE)) {
    const attrs = m[1];
    const content = m[2];
    const matchStart = m.index ?? 0;
    // Content begins right after the opening tag: match length minus content minus "</script>".
    const contentStart = matchStart + (m[0].length - content.length - "</script>".length);
    const offset = countNewlines(source.slice(0, contentStart)); // physical line of block-relative line 1, minus 1

    const sub = extractTypeScript(path, content, scriptLanguage(attrs));
    for (const n of sub.nodes) {
      if (n.id === fileId) continue; // keep our component-spanning file node
      if (seenNodes.has(n.id)) continue; // first block wins on collisions
      seenNodes.add(n.id);
      nodes.push({ ...n, startLine: n.startLine + offset, endLine: n.endLine + offset });
    }
    for (const e of sub.edges) {
      edges.push({ ...e, line: e.line + offset });
    }
    unresolved += sub.unresolved;
  }

  return { nodes, edges, unresolved, imports: [] };
}
