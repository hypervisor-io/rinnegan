import type { GraphStore } from "../graph/store.js";
import type { GraphNode, NodeKind } from "../core/types.js";
import { parseFile, type ParseResult } from "../parse/extract.js";
import { resolveImports } from "../resolution/imports.js";
import { languageOf } from "../ingest/scanner.js";
import { SPECS } from "../parse/treesitter.js";
import { BUILTINS } from "./builtins.js";

export type FindingRule = "unknown-symbol" | "signature-echo" | "blast-radius" | "parse-failure";
export interface Finding {
  severity: "error" | "warn" | "info";
  rule: FindingRule;
  file: string;
  line: number;
  message: string;
}
export interface VerifyReport {
  findings: Finding[];
  filesChecked: number;
  skipped: string[];
}
export interface VerifyInput {
  path: string;
  postImage: string | null; // null = deleted
  addedRanges: [number, number][];
}

/** Definition kinds blast-radius cares about — the things other files can call. */
const DEF_KINDS: ReadonlySet<NodeKind> = new Set(["function", "method", "class", "interface"]);

// Languages that dispatch to a real extractor in parseFile (extract.ts's switch)
// plus every tree-sitter SPECS entry — mirrors extract.ts so the parse-failure
// check only fires where "zero nodes" is actually meaningful (not merely a
// language nobody's written an extractor for yet).
const SPECIAL_LANGS = new Set([
  "typescript", "javascript", "markdown", "manifest", "mcp", "elixir", "vue", "svelte", "astro", "terraform",
]);
function hasRealExtractor(language: string): boolean {
  return SPECIAL_LANGS.has(language) || !!SPECS[language];
}

function overlaps(range: [number, number], ranges: [number, number][]): boolean {
  return ranges.some(([s, e]) => range[0] <= e && s <= range[1]);
}
function inRanges(line: number, ranges: [number, number][]): boolean {
  return ranges.some(([s, e]) => line >= s && line <= e);
}

/**
 * Thrown inside the overlay transaction to carry the finished report out while
 * forcing better-sqlite3 to roll back every write the overlay made. Verify
 * must never mutate the on-disk index — this is how that guarantee holds even
 * though the check logic needs a fully-mutated graph to query against.
 */
class Rollback extends Error {
  constructor(public report: VerifyReport) {
    super("rollback");
  }
}

interface Parsed {
  input: VerifyInput;
  res: ParseResult | null; // null only for deleted files
}

/**
 * Graph-native fact-check of a diff. Applies the diff's post-images as an
 * in-memory overlay on the persisted graph (inside a transaction that always
 * throws to roll back), then runs three checks against the overlaid state:
 * unknown-symbol, signature-echo, blast-radius — plus a parse-failure guard.
 * `root` is accepted for interface symmetry with the facade; all file content
 * verify needs is already in `inputs[].postImage`.
 */
export async function verifyChanges(
  store: GraphStore,
  _root: string,
  inputs: VerifyInput[],
  opts: { allow: Set<string> },
): Promise<VerifyReport> {
  const roles = store.roleByFile();
  const skipped = inputs
    .filter((i) => ["vendored", "generated"].includes(roles.get(i.path) ?? ""))
    .map((i) => i.path);
  const active = inputs.filter((i) => !skipped.includes(i.path));

  // parseFile is async; better-sqlite3 transactions must run synchronously —
  // so every post-image gets parsed BEFORE the transaction opens.
  const parsed: Parsed[] = [];
  for (const i of active) {
    if (i.postImage === null) {
      parsed.push({ input: i, res: null });
      continue;
    }
    const res = await parseFile(i.path, i.postImage, languageOf(i.path) ?? "");
    parsed.push({ input: i, res });
  }

  try {
    store.tx(() => {
      const report = collectFindings(store, parsed, opts, active.length, skipped);
      throw new Rollback(report);
    });
  } catch (e) {
    if (e instanceof Rollback) return e.report;
    throw e;
  }
  throw new Error("unreachable");
}

function collectFindings(
  store: GraphStore,
  parsed: Parsed[],
  opts: { allow: Set<string> },
  filesChecked: number,
  skipped: string[],
): VerifyReport {
  const findings: Finding[] = [];
  const changedPaths = new Set(parsed.map((p) => p.input.path));

  // Deleted files: capture their previously-known EXPORTED defs (for blast
  // radius) before removeFile erases the only record of them. Also snapshot
  // every changed file's def nodes' pre-overlay callers here, by node id —
  // removeFile deletes edges touching a file's own node ids from BOTH sides,
  // so an edited (not just deleted) file's incoming cross-file "calls" edges
  // (from callers outside this diff — precisely blast-radius's signal) would
  // otherwise vanish the moment that file's own removeFile runs, before we
  // ever get to ask who calls it. Node ids are deterministic on path+
  // qualifiedName, so an unrenamed def's id is unchanged pre/post overlay and
  // this snapshot still applies to its post-image counterpart.
  const deletedDefs: { path: string; node: GraphNode }[] = [];
  const priorCallers = new Map<string, GraphNode[]>();
  for (const p of parsed) {
    const meta = store.getFileMeta(p.input.path);
    if (!meta) continue;
    for (const id of meta.nodeIds) {
      const n = store.getNode(id);
      if (!n || !DEF_KINDS.has(n.kind)) continue;
      priorCallers.set(
        id,
        store.incoming(id, ["calls"]).map((e) => store.getNode(e.source)).filter((c): c is GraphNode => !!c),
      );
      if (p.input.postImage === null && n.isExported) deletedDefs.push({ path: p.input.path, node: n });
    }
  }

  // Overlay: replace each changed file's slice of the graph with its post-image.
  for (const p of parsed) {
    store.removeFile(p.input.path);
    if (p.res) {
      for (const n of p.res.nodes) store.insertNode(n);
      for (const e of p.res.edges) store.insertEdge(e);
      store.setImports(p.input.path, p.res.imports);
    }
  }
  resolveImports(store);

  // Whole-graph qualifiedName index for the unknown-symbol check, built once
  // post-overlay/post-resolution. Excludes "unresolved" placeholder nodes —
  // every unresolved call's own boundary node's qualifiedName ends with
  // ".<name>", which would otherwise make it look resolved against itself.
  const knownNames = store.allNodes().filter((n) => n.kind !== "unresolved").map((n) => n.qualifiedName);
  const existsInGraph = (name: string) => knownNames.some((qn) => qn === name || qn.endsWith(`.${name}`));

  // parse-failure: non-empty post-image, real extractor, yet zero symbols extracted.
  for (const p of parsed) {
    if (!p.res || p.input.postImage === null || p.input.postImage.length === 0) continue;
    const language = languageOf(p.input.path) ?? "";
    if (!hasRealExtractor(language)) continue;
    const nonFileNodes = p.res.nodes.filter((n) => n.kind !== "file");
    if (nonFileNodes.length === 0 && p.res.edges.length === 0) {
      findings.push({
        severity: "error",
        rule: "parse-failure",
        file: p.input.path,
        line: 1,
        message: `${p.input.path} produced no parseable symbols — possible syntax error`,
      });
    }
  }

  // unknown-symbol + signature-echo: walk `calls` edges owned by nodes of each
  // changed file, restricted to edges landing inside that file's added lines.
  for (const p of parsed) {
    if (!p.res) continue;
    const language = languageOf(p.input.path) ?? "";
    const importsLocal = new Set(store.getImports(p.input.path).map((i) => i.localName));
    for (const n of p.res.nodes) {
      for (const e of store.outgoing(n.id, ["calls"])) {
        if (!inRanges(e.line, p.input.addedRanges)) continue;
        const callee = store.getNode(e.target);
        if (!callee) continue;

        if (e.provenance === "unresolved") {
          const name = callee.qualifiedName.replace(/^<unresolved>\./, "");
          if (opts.allow.has(name)) continue;
          if (importsLocal.has(name)) continue;
          if (existsInGraph(name)) continue;
          const builtinsSet = BUILTINS[language];
          if (builtinsSet?.has(name)) continue;
          findings.push({
            severity: builtinsSet ? "error" : "info",
            rule: "unknown-symbol",
            file: p.input.path,
            line: e.line,
            message: `call to '${name}' — no such symbol exists in this codebase (possible hallucination)`,
          });
        } else if (e.provenance === "ast_exact" || e.provenance === "ast_inferred") {
          const name = callee.qualifiedName;
          findings.push({
            severity: "info",
            rule: "signature-echo",
            file: p.input.path,
            line: e.line,
            message: `${name} is ${callee.signature ?? callee.qualifiedName} — ${callee.filePath}:${callee.startLine}`,
          });
        }
      }
    }
  }

  // blast-radius: defs in changed lines (or all exported defs of a deleted
  // file) whose callers live outside this diff.
  const blastRadius = (def: GraphNode, path: string) => {
    const callerNodes = (priorCallers.get(def.id) ?? []).filter((c) => !changedPaths.has(c.filePath));
    const uniq = [...new Map(callerNodes.map((c) => [c.id, c])).values()].sort((a, b) =>
      a.filePath === b.filePath ? a.startLine - b.startLine : a.filePath < b.filePath ? -1 : 1,
    );
    if (uniq.length === 0) return;
    findings.push({
      severity: "warn",
      rule: "blast-radius",
      file: path,
      line: def.startLine,
      message: `${def.qualifiedName} changed — ${uniq.length} caller(s) outside this diff: ${uniq
        .slice(0, 3)
        .map((c) => `${c.filePath}:${c.startLine}`)
        .join(", ")}`,
    });
  };
  for (const p of parsed) {
    if (!p.res) continue;
    for (const n of p.res.nodes) {
      if (!DEF_KINDS.has(n.kind)) continue;
      if (!overlaps([n.startLine, n.endLine], p.input.addedRanges)) continue;
      blastRadius(n, p.input.path);
    }
  }
  for (const { path, node } of deletedDefs) blastRadius(node, path);

  return { findings: sortFindings(findings), filesChecked, skipped };
}

/** Deterministic ordering: (file, line, rule). Exported so the facade can
 * re-sort after appending its own parse-failure findings (diff-apply errors
 * caught outside verifyChanges, before the overlay ever ran). */
export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.line !== b.line) return a.line - b.line;
    return a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0;
  });
}
