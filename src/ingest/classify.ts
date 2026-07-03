import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

export type FileRole = "entrypoint" | "test" | "config" | "generated" | "vendored" | "doc" | "library";

export interface ClassifyContext {
  entryTargets: Set<string>; // normalized relative paths named by manifest bin/main/exports
  manifestDirs: Set<string>; // dirs (relative, "" for root) containing a recognized manifest
}

const VENDOR_SEGS = new Set(["vendor", "third_party", "vendored"]);
const GENERATED_RE = /@generated|DO NOT EDIT/;
const TEST_PATH_RE = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[^./]+$|(^|\/)test_[^/]+\.py$|_test\.go$/;
// Scoped per-language so a bare import name isn't a test signal in the wrong
// language (e.g. Go's stdlib "testing" package would otherwise false-positive
// a TypeScript file that imports a module literally named "testing").
const JS_TEST_FRAMEWORKS = new Set(["vitest", "jest", "@jest/globals", "mocha", "chai", "node:test", "ava", "tap", "supertest"]);
const EMPTY_TEST_FRAMEWORKS = new Set<string>();
const TEST_FRAMEWORKS: Record<string, Set<string>> = {
  typescript: JS_TEST_FRAMEWORKS,
  javascript: JS_TEST_FRAMEWORKS,
  python: new Set(["pytest", "unittest"]),
  go: new Set(["testing"]),
  ruby: new Set(["rspec", "minitest"]),
};
const CONFIG_RE = /(^|\/)(tsconfig[^/]*\.json|\.eslintrc[^/]*|[^/]+\.config\.(js|ts|mjs|cjs|mts)|dockerfile|makefile)$/i;

/**
 * Pure, deterministic file-role classification. Precedence is spec-fixed —
 * vendored → generated → test → entrypoint → config → doc → library, first
 * match wins — so ranking/verify/domains (later phases) get a stable signal
 * independent of parse order or file discovery order.
 */
export function classifyFile(
  path: string,
  source: string,
  language: string,
  imports: string[],
  ctx: ClassifyContext,
): FileRole {
  const p = path.replace(/\\/g, "/");
  if (p.split("/").some((s) => VENDOR_SEGS.has(s.toLowerCase()))) return "vendored";
  if (GENERATED_RE.test(source.split("\n", 20).join("\n"))) return "generated";
  const frameworks = TEST_FRAMEWORKS[language] ?? EMPTY_TEST_FRAMEWORKS;
  if (TEST_PATH_RE.test(p) || imports.some((i) => frameworks.has(i))) return "test";
  if (ctx.entryTargets.has(p) || source.startsWith("#!")) return "entrypoint";
  const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (ctx.manifestDirs.has(dir) && /^(main|index)\.[^.]+$/.test(base)) return "entrypoint";
  if (CONFIG_RE.test(p) || language === "manifest" || language === "mcp") return "config";
  if (language === "markdown") return "doc";
  return "library";
}

function collectExportLeaves(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectExportLeaves(v, out);
  }
}

/** Normalize a manifest-declared target to a POSIX-ish relative path, stripping "./"  and OS-sep quirks. */
function normalizeTarget(manifestPath: string, value: string): string {
  const rel = normalize(join(dirname(manifestPath), value)).replace(/\\/g, "/");
  return rel.startsWith("./") ? rel.slice(2) : rel;
}

/**
 * Reads on-disk manifests to build the context classifyFile needs: entrypoint
 * targets declared by package.json (bin/main/exports) and every directory
 * that holds a recognized manifest (root gets "").
 */
export function buildClassifyContext(root: string, manifestPaths: string[]): ClassifyContext {
  const entryTargets = new Set<string>();
  const manifestDirs = new Set<string>();

  for (const manifestPath of manifestPaths) {
    const p = manifestPath.replace(/\\/g, "/");
    const dir = dirname(p);
    manifestDirs.add(dir === "." ? "" : dir);

    if (basenameLower(p) !== "package.json") continue;
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(join(root, p), "utf8"));
    } catch {
      continue;
    }
    if (!json || typeof json !== "object") continue;
    const j = json as Record<string, unknown>;

    if (typeof j.main === "string") entryTargets.add(normalizeTarget(p, j.main));

    if (typeof j.bin === "string") entryTargets.add(normalizeTarget(p, j.bin));
    else if (j.bin && typeof j.bin === "object") {
      for (const v of Object.values(j.bin as Record<string, unknown>)) {
        if (typeof v === "string") entryTargets.add(normalizeTarget(p, v));
      }
    }

    if (j.exports !== undefined) {
      const leaves: string[] = [];
      collectExportLeaves(j.exports, leaves);
      for (const v of leaves) entryTargets.add(normalizeTarget(p, v));
    }
  }

  return { entryTargets, manifestDirs };
}

function basenameLower(path: string): string {
  const p = path.replace(/\\/g, "/");
  return p.slice(p.lastIndexOf("/") + 1).toLowerCase();
}
