import { dirname, join, normalize } from "node:path";

const EXT_CANDIDATES = ["", ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
const INDEX_CANDIDATES = ["/index.ts", "/index.tsx", "/index.js", "/index.jsx"];

/**
 * Minimal shape `resolveModulePath` needs from a store. Kept as a structural
 * interface (not `GraphStore`) so this module has no dependency on
 * `graph/store.ts` — `store.ts` needs this function too (removeFile's
 * downgrade path), and importing the full `GraphStore` type here would create
 * a store.ts <-> imports.ts style cycle for no reason.
 */
export interface FileExistsLookup {
  fileExists(path: string): boolean;
}

/** Resolve a relative module specifier to an indexed file path, or undefined. */
export function resolveModulePath(fromFile: string, spec: string, store: FileExistsLookup): string | undefined {
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
