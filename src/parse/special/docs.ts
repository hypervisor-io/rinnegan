import { dirname, join, normalize } from "node:path";
import { nodeId } from "../../core/types.js";
import type { GraphNode, GraphEdge } from "../../core/types.js";
import type { ParseResult } from "../extract.js";
import { LANG_EXT, DOC_EXT } from "../../ingest/scanner.js";

// Extensions that make a backtick-quoted token read as a bare filename, not a
// symbol mention (reuses scanner.ts's tables so this list doesn't drift).
const KNOWN_EXT = new Set([...Object.keys(LANG_EXT), ...DOC_EXT, ".json", ".yaml", ".yml", ".toml", ".lock"]);

function looksLikeFilename(name: string): boolean {
  if (name.includes("/")) return true;
  const lower = name.toLowerCase();
  for (const ext of KNOWN_EXT) if (lower.endsWith(ext)) return true;
  return false;
}

/**
 * Docs extractor: markdown `[text](./other.md)` links and `[[wikilinks]]` become
 * `references` edges between documents — so docs join the same knowledge graph.
 * Inline-code identifiers (`` `realFn` ``, outside fenced code blocks) become
 * `references` edges to a `<docref>.<name>` unresolved node, so `Rinnegan.staleDocs()`
 * can flag doc mentions of symbols that no longer exist.
 */
export function extractDocs(path: string, source: string, language: string): ParseResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const lines = source.split("\n");

  const fileId = nodeId(path, "<file>");
  nodes.push({ id: fileId, kind: "file", qualifiedName: "<file>", filePath: path, language, startLine: 1, endLine: lines.length });

  const linkRe = /\[[^\]]*\]\(([^)\s]+)\)/g;
  const wikiRe = /\[\[([^\]]+)\]\]/g;
  const mentionRe = /`([A-Za-z_$][A-Za-z0-9_$.]{2,})`/g;
  const seen = new Set<string>();
  const mentionsSeen = new Set<string>();
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue; // fence delimiter itself isn't scanned
    }
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
    if (inFence) continue;
    mentionRe.lastIndex = 0;
    while ((m = mentionRe.exec(line))) {
      const name = m[1];
      if (looksLikeFilename(name) || mentionsSeen.has(name)) continue;
      mentionsSeen.add(name);
      const tid = nodeId("<docref>", name);
      nodes.push({ id: tid, kind: "unresolved", qualifiedName: `<docref>.${name}`, filePath: path, language, startLine: i + 1, endLine: i + 1 });
      edges.push({ source: fileId, target: tid, kind: "references", line: i + 1, col: 1, provenance: "heuristic", confidence: 0.4, resolver: "docs-inline" });
    }
  }

  return { nodes, edges, unresolved: 0, imports: [] };
}
