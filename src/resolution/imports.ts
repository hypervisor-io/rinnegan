import { dirname, join, normalize } from "node:path";
import { GraphStore } from "../graph/store.js";

const EXT_CANDIDATES = ["", ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
const INDEX_CANDIDATES = ["/index.ts", "/index.tsx", "/index.js", "/index.jsx"];

/** Resolve a relative module specifier to an indexed file path, or undefined. */
export function resolveModulePath(fromFile: string, spec: string, store: GraphStore): string | undefined {
  if (!spec.startsWith(".")) return undefined; // bare/external import — leave unresolved (honest)
  const base = normalize(join(dirname(fromFile), spec));
  for (const ext of EXT_CANDIDATES) {
    const cand = base + ext;
    if (store.fileExists(cand)) return cand;
  }
  for (const idx of INDEX_CANDIDATES) {
    const cand = base + idx;
    if (store.fileExists(cand)) return cand;
  }
  return undefined;
}

/**
 * Cross-file import resolution. Rewrites `unresolved` call edges to `ast_inferred`
 * cross-file calls when the callee is an imported, exported symbol. Deterministic.
 */
export function resolveImports(store: GraphStore): number {
  let resolvedCount = 0;
  const unresolved = store.allEdges().filter((e) => e.kind === "calls" && e.provenance === "unresolved");

  for (const e of unresolved) {
    const src = store.getNode(e.source);
    const tgt = store.getNode(e.target);
    if (!src || !tgt) continue;

    const calleeName = tgt.qualifiedName.replace(/^<unresolved>\./, "");
    const imp = store.getImports(src.filePath).find((i) => i.localName === calleeName);
    if (!imp || imp.importedName === "*" ) continue;

    const targetFile = resolveModulePath(src.filePath, imp.moduleSpec, store);
    if (!targetFile) continue;

    // default import: pick the file's single exported symbol if unambiguous
    const name = imp.importedName === "default" ? defaultExportName(store, targetFile) : imp.importedName;
    if (!name) continue;
    const exported = store.findExportedNode(targetFile, name);
    if (!exported) continue;

    store.deleteEdge(e);
    store.insertEdge({
      ...e,
      target: exported.id,
      provenance: "ast_inferred",
      confidence: 0.9,
      resolver: "ts-import",
      metadata: { crossFile: true, module: imp.moduleSpec },
    });
    resolvedCount++;
  }
  return resolvedCount;
}

function defaultExportName(store: GraphStore, file: string): string | undefined {
  const exported = store.allNodes().filter((n) => n.filePath === file && n.isExported);
  return exported.length === 1 ? exported[0].qualifiedName : undefined;
}
