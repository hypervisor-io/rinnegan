import { dirname, join, normalize } from "node:path";

const EXT_CANDIDATES = ["", ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
const INDEX_CANDIDATES = ["/index.ts", "/index.tsx", "/index.js", "/index.jsx"];

// TS NodeNext mandates import specifiers spelled with the *emitted* JS
// extension (`./store.js`) even though the source file on disk is `.ts` —
// so a literal candidate lookup never finds it. Standard TS module
// resolution remaps these; mirror that here as a fallback (tried only after
// every literal candidate above has missed, so a real .js file still wins).
const JS_TO_TS_REMAP: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

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
  for (const [jsExt, tsExts] of Object.entries(JS_TO_TS_REMAP)) {
    if (!base.endsWith(jsExt)) continue;
    const stem = base.slice(0, -jsExt.length);
    for (const tsExt of tsExts) {
      const cand = stem + tsExt;
      if (store.fileExists(cand)) return cand;
    }
    break; // spec's extension matches exactly one remap entry
  }
  return undefined;
}
