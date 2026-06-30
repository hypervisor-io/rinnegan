import { nodeId } from "../../core/types.js";
import type { GraphNode, GraphEdge } from "../../core/types.js";
import type { ParseResult } from "../extract.js";

const PKG_ROOT = "<packages>";

function pkgFromArgs(command: string | undefined, args: string[]): string | undefined {
  if (!command) return undefined;
  if (/^(npx|bunx|pnpm|yarn|uvx|uv|pipx)$/.test(command)) {
    for (const a of args) {
      if (a.startsWith("-")) continue; // skip flags like -y
      if (a === "dlx" || a === "run" || a === "tool" || a === "install") continue;
      return a;
    }
  }
  return command; // the binary itself is the dependency
}

/**
 * MCP config extractor: each server becomes a node carrying its command, args and
 * required env vars; its package (npx/uvx target) joins the canonical package hub.
 */
export function extractMcp(path: string, source: string, language: string): ParseResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const fileId = nodeId(path, "<file>");
  nodes.push({ id: fileId, kind: "file", qualifiedName: "<file>", filePath: path, language, startLine: 1, endLine: source.split("\n").length });

  let j: Record<string, unknown>;
  try {
    j = JSON.parse(source) as Record<string, unknown>;
  } catch {
    return { nodes, edges, unresolved: 0, imports: [] };
  }
  const servers = (j.mcpServers ?? j.servers ?? {}) as Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;

  for (const [name, cfg] of Object.entries(servers)) {
    const c = cfg ?? {};
    const args = Array.isArray(c.args) ? c.args : [];
    const env = c.env ? Object.keys(c.env) : [];
    const sid = nodeId(path, `server.${name}`);
    nodes.push({
      id: sid, kind: "module", qualifiedName: `server.${name}`, filePath: path, language,
      startLine: 1, endLine: 1,
      signature: `mcp server ${name}: ${c.command ?? ""} ${args.join(" ")}`.trim().slice(0, 200),
      docstring: env.length ? `requires env: ${env.join(", ")}` : undefined,
    });
    edges.push({ source: fileId, target: sid, kind: "contains", line: 1, col: 1, provenance: "ast_exact", confidence: 1, resolver: "mcp-config" });

    const pkg = pkgFromArgs(c.command, args);
    if (pkg) {
      const hub = nodeId(PKG_ROOT, pkg);
      nodes.push({ id: hub, kind: "module", qualifiedName: pkg, filePath: PKG_ROOT, language: "package", startLine: 1, endLine: 1, signature: `package ${pkg}` });
      edges.push({ source: sid, target: hub, kind: "references", line: 1, col: 1, provenance: "heuristic", confidence: 0.7, resolver: "mcp-pkg", metadata: { dependsOn: true } });
    }
  }
  return { nodes, edges, unresolved: 0, imports: [] };
}
