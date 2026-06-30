import { basename } from "node:path";
import { nodeId } from "../../core/types.js";
import type { GraphNode, GraphEdge } from "../../core/types.js";
import type { ParseResult } from "../extract.js";

/** Canonical package hub path — same dep name from any manifest → one hub node. */
const PKG_ROOT = "<packages>";

function depsFor(base: string, source: string): string[] {
  const out: string[] = [];
  if (base === "package.json") {
    try {
      const j = JSON.parse(source) as Record<string, Record<string, string>>;
      for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        if (j[k]) out.push(...Object.keys(j[k]));
      }
    } catch { /* ignore */ }
  } else if (base === "go.mod") {
    for (const line of source.split("\n")) {
      const m = /^\s*(?:require\s+)?([\w.\-/]+)\s+v\d/.exec(line);
      if (m && !/^(module|go|toolchain)\b/.test(line.trim())) out.push(m[1]);
    }
  } else if (base === "pyproject.toml") {
    const arr = /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(source);
    if (arr) for (const m of arr[1].matchAll(/["']([A-Za-z0-9_.\-]+)/g)) out.push(m[1]);
    const poetry = /\[tool\.poetry\.dependencies\]([\s\S]*?)(\n\[|$)/.exec(source);
    if (poetry) {
      for (const line of poetry[1].split("\n")) {
        const m = /^\s*([A-Za-z0-9_.\-]+)\s*=/.exec(line);
        if (m && m[1].toLowerCase() !== "python") out.push(m[1]);
      }
    }
  } else if (base === "cargo.toml") {
    const dep = /\[dependencies\]([\s\S]*?)(\n\[|$)/.exec(source);
    if (dep) for (const line of dep[1].split("\n")) {
      const m = /^\s*([A-Za-z0-9_.\-]+)\s*=/.exec(line);
      if (m) out.push(m[1]);
    }
  } else if (base === "pom.xml") {
    for (const m of source.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)) out.push(m[1].trim());
  } else if (base === "apm.yml") {
    for (const m of source.matchAll(/^\s*-?\s*([A-Za-z0-9_.\-/]+):/gm)) out.push(m[1]);
  }
  return out;
}

/**
 * Manifest extractor: one canonical package hub node per dependency name (shared
 * across all manifests) + `references` (depends_on) edges from the manifest.
 */
export function extractManifest(path: string, source: string, language: string): ParseResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const fileId = nodeId(path, "<file>");
  nodes.push({ id: fileId, kind: "file", qualifiedName: "<file>", filePath: path, language, startLine: 1, endLine: source.split("\n").length });

  const seen = new Set<string>();
  for (const raw of depsFor(basename(path).toLowerCase(), source)) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const hub = nodeId(PKG_ROOT, name);
    nodes.push({ id: hub, kind: "module", qualifiedName: name, filePath: PKG_ROOT, language: "package", startLine: 1, endLine: 1, signature: `package ${name}` });
    edges.push({ source: fileId, target: hub, kind: "references", line: 1, col: 1, provenance: "ast_exact", confidence: 1, resolver: "manifest-dep", metadata: { dependsOn: true } });
  }
  return { nodes, edges, unresolved: 0, imports: [] };
}
