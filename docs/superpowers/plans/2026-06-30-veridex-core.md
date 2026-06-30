# Rinnegan Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a working verifiable code-knowledge engine that returns minimal, provenance-tagged, signal-dense slices of a codebase for AI agents — deterministic, no neural embeddings.

**Architecture:** Layered TS library (ingest → AST parse → provenance graph in SQLite → deterministic LSA+BM25 semantic → signal/position emission) exposed through a library API, a CLI, and an MCP server. Every graph edge carries provenance + confidence; semantic discovery uses local TF-IDF + truncated SVD (no model, no API).

**Tech Stack:** TypeScript (ESM), Node 22+ (`node:sqlite`), web-tree-sitter (WASM grammars for TS/Python/Go), vitest, commander (CLI), @modelcontextprotocol/sdk (MCP).

## Global Constraints

- Node.js >= 20; ESM modules (`"type": "module"`). SQLite via `better-sqlite3`
  (prebuilt binary, WAL + FTS5) — the durable codebase knowledge store, NOT a flat
  dump. (`node:sqlite` is interchangeable behind `GraphStore` on Node ≥22.5.)
- NO neural embeddings, NO external AI/tokenization API anywhere. Semantic layer is pure local linear algebra.
- Determinism: identical corpus ⇒ byte-identical index and byte-identical `understand()` output. No `Date.now()`/`Math.random()` in index or output paths.
- Every emitted graph edge MUST carry `provenance` and `confidence`. Only `ast_exact` is "ground truth".
- TDD: failing test first, then minimal impl, then commit. One responsibility per file; keep files focused.
- Zero copied code from codegraph/repomix/grepai — patterns only.

---

### Task 0: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/version.ts`, `README.md`

**Interfaces:**
- Produces: build/test scripts; `VERSION` constant.

- [ ] **Step 1:** Write `package.json` with ESM, scripts (`build`, `test`, `test:watch`, `cli`), deps: `web-tree-sitter`, `tree-sitter-typescript`, `tree-sitter-python`, `tree-sitter-go`, `commander`, `@modelcontextprotocol/sdk`; devDeps: `typescript`, `vitest`, `@types/node`.
- [ ] **Step 2:** Write `tsconfig.json` (target ES2022, module NodeNext, strict, outDir `dist`, rootDir `src`).
- [ ] **Step 3:** Write `vitest.config.ts`, `.gitignore` (`node_modules`, `dist`, `.rinnegan`, `*.wasm` cache), `src/version.ts` (`export const VERSION = "0.1.0"`).
- [ ] **Step 4:** Run `npm install`. Expected: deps resolve.
- [ ] **Step 5:** Commit `chore: scaffold Rinnegan TS project`.

---

### Task 1: Core types + provenance model

**Files:**
- Create: `src/core/types.ts`
- Test: `src/core/types.test.ts`

**Interfaces:**
- Produces: `NodeKind`, `EdgeKind`, `Provenance`, `ReadWrite`, `GraphNode`, `GraphEdge`, `nodeId(filePath, qualifiedName)` (sha256 hex), `PROVENANCE_TRUST` map.

- [ ] **Step 1: Write failing test** — `nodeId` is deterministic & stable; `PROVENANCE_TRUST.ast_exact === 1`.

```ts
import { describe, it, expect } from "vitest";
import { nodeId, PROVENANCE_TRUST } from "./types.js";
describe("core types", () => {
  it("nodeId deterministic", () => {
    expect(nodeId("a.ts", "Foo.bar")).toBe(nodeId("a.ts", "Foo.bar"));
    expect(nodeId("a.ts", "Foo.bar")).not.toBe(nodeId("b.ts", "Foo.bar"));
  });
  it("ast_exact is full trust", () => {
    expect(PROVENANCE_TRUST.ast_exact).toBe(1);
    expect(PROVENANCE_TRUST.unresolved).toBe(0);
  });
});
```

- [ ] **Step 2:** Run `npx vitest run src/core/types.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `src/core/types.ts`:

```ts
import { createHash } from "node:crypto";

export type NodeKind =
  | "file" | "module" | "class" | "struct" | "interface" | "function"
  | "method" | "property" | "field" | "variable" | "constant" | "enum"
  | "enum_member" | "type_alias" | "import" | "export" | "unresolved";

export type EdgeKind =
  | "contains" | "calls" | "imports" | "exports" | "extends" | "implements"
  | "references" | "type_of" | "returns" | "instantiates" | "overrides" | "decorates";

export type Provenance =
  | "ast_exact" | "ast_inferred" | "lexical" | "latent" | "heuristic" | "unresolved";

export type ReadWrite = "read" | "write" | "readwrite" | "call" | "addr" | "none";

export const PROVENANCE_TRUST: Record<Provenance, number> = {
  ast_exact: 1, ast_inferred: 0.8, heuristic: 0.5,
  lexical: 0.3, latent: 0.3, unresolved: 0,
};

export interface GraphNode {
  id: string;
  kind: NodeKind;
  qualifiedName: string;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  signature?: string;
  docstring?: string;
  isExported?: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  line: number;
  col: number;
  provenance: Provenance;
  confidence: number;
  resolver: string;
  readWrite?: ReadWrite;
  metadata?: Record<string, unknown>;
}

export function nodeId(filePath: string, qualifiedName: string): string {
  return createHash("sha256").update(`${filePath}::${qualifiedName}`).digest("hex").slice(0, 24);
}
```

- [ ] **Step 4:** Run test. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): provenance-centric node/edge types`.

---

### Task 2: Graph store (SQLite + provenance schema)

**Files:**
- Create: `src/graph/schema.sql`, `src/graph/store.ts`
- Test: `src/graph/store.test.ts`

**Interfaces:**
- Consumes: `GraphNode`, `GraphEdge` (Task 1).
- Produces: class `GraphStore` — `open(dbPath)`, `insertNode(n)`, `insertEdge(e)`, `getNode(id)`, `outgoing(id, kinds?)`, `incoming(id, kinds?)`, `searchFts(query, limit)`, `allNodes()`, `close()`, `tx(fn)`. Edges persist provenance/confidence/resolver/readWrite.

- [ ] **Step 1: Write failing test** — insert node+edge, read back with provenance; FTS finds by name.

```ts
import { describe, it, expect } from "vitest";
import { GraphStore } from "./store.js";
describe("GraphStore", () => {
  it("persists provenance + retrieves edges and fts", () => {
    const g = GraphStore.open(":memory:");
    g.insertNode({ id: "a", kind: "function", qualifiedName: "login", filePath: "a.ts", language: "ts", startLine: 1, endLine: 3 });
    g.insertNode({ id: "b", kind: "function", qualifiedName: "session", filePath: "a.ts", language: "ts", startLine: 5, endLine: 9 });
    g.insertEdge({ source: "a", target: "b", kind: "calls", line: 2, col: 1, provenance: "ast_exact", confidence: 1, resolver: "ts", readWrite: "call" });
    expect(g.outgoing("a")[0].provenance).toBe("ast_exact");
    expect(g.incoming("b")[0].source).toBe("a");
    expect(g.searchFts("login", 5).map(n => n.id)).toContain("a");
    g.close();
  });
});
```

- [ ] **Step 2:** Run test. Expected: FAIL.
- [ ] **Step 3: Implement** `src/graph/schema.sql` (tables `nodes`, `edges` with `provenance,confidence,resolver,read_write,metadata` cols; FTS5 `nodes_fts` over `qualifiedName,signature,docstring` + triggers; indexes on `edges(source)`, `edges(target)`) and `src/graph/store.ts` wrapping `node:sqlite` `DatabaseSync`, WAL mode, prepared statements, `tx()` via `BEGIN/COMMIT`.
- [ ] **Step 4:** Run test. Expected: PASS.
- [ ] **Step 5:** Commit `feat(graph): sqlite store with provenance schema + fts`.

---

### Task 3: Ingest (file scanner)

**Files:**
- Create: `src/ingest/scanner.ts`
- Test: `src/ingest/scanner.test.ts`

**Interfaces:**
- Produces: `scanFiles(root, opts?)` → `{ path, size }[]`; git-first (`git ls-files`), fallback walk; ignores defaults + `.gitignore`/`.rinneganignore`; skips >1MB, binary ext, `*.min.*`/`*.bundle.*`. `contentHash(buf)` → sha256.

- [ ] **Step 1: Write failing test** — scanning a temp dir returns source files, excludes `node_modules` and `*.min.js`.
- [ ] **Step 2:** Run test. Expected: FAIL.
- [ ] **Step 3: Implement** scanner (use `child_process` `git ls-files` when `.git` present; else recursive `fs.readdir`; extension allow-list from a `LANG_EXT` map; size/binary/minified filters).
- [ ] **Step 4:** Run test. Expected: PASS.
- [ ] **Step 5:** Commit `feat(ingest): git-first file scanner with filters`.

---

### Task 4: Parse (tree-sitter + scope-aware TS extractor)

**Files:**
- Create: `src/parse/grammars.ts`, `src/parse/extract.ts`, `src/parse/lang/typescript.ts`
- Test: `src/parse/typescript.test.ts`

**Interfaces:**
- Consumes: `GraphNode`, `GraphEdge`.
- Produces: `parseFile(path, source, language)` → `{ nodes, edges, unresolved }`. TS extractor emits `function/method/class` nodes, `calls` edges with **scope-aware resolution** (local decl in same file wins over same-named other-file symbol — the #1079 fix), and `references` edges carrying `readWrite` (`write` for assignment LHS, `read` otherwise — the #996 fix). Unresolvable callee ⇒ `unresolved` node + edge `provenance:"unresolved"`.

- [ ] **Step 1: Write failing test** — given two files each defining `helper`, a call to `helper` in file A resolves to A's `helper` (not B's); an assignment `x = 1` yields `readWrite:"write"`, a use `return x` yields `read`.

```ts
import { describe, it, expect } from "vitest";
import { parseFile } from "./extract.js";
it("scope-aware resolution + read/write", async () => {
  const a = `function helper(){return 1} function main(){ let x = helper(); return x }`;
  const r = await parseFile("a.ts", a, "typescript");
  const call = r.edges.find(e => e.kind === "calls");
  expect(call?.provenance).toBe("ast_exact");
  const writes = r.edges.filter(e => e.readWrite === "write");
  const reads = r.edges.filter(e => e.readWrite === "read");
  expect(writes.length).toBeGreaterThan(0);
  expect(reads.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2:** Run test. Expected: FAIL.
- [ ] **Step 3: Implement** WASM grammar loader (`grammars.ts` lazy-loads `tree-sitter-typescript` wasm), generic `extract.ts` dispatcher, and `lang/typescript.ts` walking the tree: collect declarations into a scope table keyed by name with line ranges; resolve identifiers to the nearest enclosing-scope decl first; tag assignment targets as `write`.
- [ ] **Step 4:** Run test. Expected: PASS.
- [ ] **Step 5:** Commit `feat(parse): tree-sitter TS extractor, scope-aware + read/write`.

*(Python and Go extractors follow the same interface in Phase 5; `lang/python.ts`, `lang/go.ts`.)*

---

### Task 5: Indexer orchestrator

**Files:**
- Create: `src/index/indexer.ts`
- Test: `src/index/indexer.test.ts`

**Interfaces:**
- Consumes: `scanFiles`, `parseFile`, `GraphStore`.
- Produces: `Indexer.indexAll(root, dbPath)` → `{ files, nodes, edges }`; two-gate incremental (mtime + contentHash stored in a `files` table); deterministic commit order (sorted by path).

- [ ] **Step 1: Write failing test** — indexing a 2-file fixture yields expected node count; re-running with no changes performs zero re-parses (skip count == files).
- [ ] **Step 2:** Run test. Expected: FAIL.
- [ ] **Step 3: Implement** orchestrator: scan → for each (sorted) file two-gate check → parse → `store.tx()` insert → record hash.
- [ ] **Step 4:** Run test. Expected: PASS.
- [ ] **Step 5:** Commit `feat(index): indexer with deterministic two-gate incremental`.

---

### Task 6: Deterministic semantic layer (TF-IDF + LSA + BM25 + RRF)

**Files:**
- Create: `src/semantic/tokenize.ts`, `src/semantic/tfidf.ts`, `src/semantic/svd.ts`, `src/semantic/lsa.ts`, `src/semantic/bm25.ts`, `src/semantic/fuse.ts`
- Test: `src/semantic/lsa.test.ts`, `src/semantic/svd.test.ts`

**Interfaces:**
- Produces: `splitIdentifier(s)` (camel/snake → tokens + synonym expand); `buildTfidf(docs)`; `truncatedSvd(matrix, k, {seed})` (deterministic via fixed-seed power iteration / Lanczos, sign-canonicalized); `LsaIndex.build(symbolDocs)` + `.query(text, limit)` (cosine in latent space); `bm25Search(docs, query, limit)`; `rrfFuse(lists, k=60)`. All deterministic.

- [ ] **Step 1: Write failing tests** — (a) `truncatedSvd` on a fixed small matrix returns sign-canonicalized singular vectors identical across two runs; (b) `LsaIndex` ranks a doc about "user authentication" above an unrelated doc for query "login flow".

```ts
import { describe, it, expect } from "vitest";
import { truncatedSvd } from "./svd.js";
it("svd is deterministic + sign-canonical", () => {
  const m = [[1,0,0],[0,1,0],[1,1,0],[0,0,1]];
  const a = truncatedSvd(m, 2, { seed: 42 });
  const b = truncatedSvd(m, 2, { seed: 42 });
  expect(a.s).toEqual(b.s);
  expect(a.u).toEqual(b.u);
});
```

- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3: Implement** modules. SVD via deterministic seeded power-iteration with Gram–Schmidt deflation (k components), each singular vector sign-fixed so its largest-magnitude entry is positive (canonicalization ⇒ determinism). LSA folds query via `q·V·Σ⁻¹`. BM25 standard (k1=1.5,b=0.75). RRF sums `1/(k+rank)`.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(semantic): deterministic LSA + BM25 + RRF (no neural net)`.

---

### Task 7: Signal engine (spine → rerank → skeletonize → position emit)

**Files:**
- Create: `src/signal/spine.ts`, `src/signal/rank.ts`, `src/signal/budget.ts`, `src/signal/render.ts`, `src/signal/understand.ts`
- Test: `src/signal/understand.test.ts`, `src/signal/rank.test.ts`

**Interfaces:**
- Consumes: `GraphStore`, semantic indices, source files.
- Produces: `understand(store, semantic, task, opts)` → `{ text, facts, tokensEstimate }`. Pipeline: seed (fuse) → `extractSpine` (minimal connected subgraph over calls/deps/types, depth-bounded) → `rankNodes` (`centrality × relevance × provenanceConfidence × changeRecency`) → skeletonize off-spine to signatures → `budget` (cap tokens) → `positionOrder` (highest signal first+last, low in middle) → `render` (provenance tag + `file:line` + line-numbered source; dynamic dispatch ⇒ "static path ends here"). Render applies **whitespace minimization**: `minifyBlock(lines, startLine)` uniform-dedents the block, elides pure-blank lines (signalled by line-number gaps), and trims trailing whitespace — zero information loss because line numbers are explicit.

- [ ] **Step 1: Write failing tests** — (a) `rankNodes` ranks an `ast_exact`-connected, query-relevant node above an `unresolved`, irrelevant one; (b) `understand` output contains the anchor symbol's `file:line` and stays under the token budget; (c) every rendered fact line carries a provenance tag.
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3: Implement** the five modules.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(signal): minimal-spine, provenance-ranked, position-aware emission`.

---

### Task 8: Library API

**Files:**
- Create: `src/index.ts`
- Test: `src/library.test.ts`

**Interfaces:**
- Produces: `class Rinnegan` — `static open(root)`, `indexAll()`, `understand(task, opts?)`, `search(q)`, `deps(filePath)`, `refs(symbol, {readWrite?})`, `callers(symbol)`, `impact(symbol)`, `close()`. Wires Tasks 2–7.

- [ ] **Step 1: Write failing test** — `Rinnegan.open(fixtureRoot)` → `indexAll()` → `understand("authentication")` returns text mentioning the auth fixture symbol.
- [ ] **Step 2:** Run test. Expected: FAIL.
- [ ] **Step 3: Implement** facade.
- [ ] **Step 4:** Run test. Expected: PASS.
- [ ] **Step 5:** Commit `feat(lib): Rinnegan public API`.

---

### Task 9: CLI

**Files:**
- Create: `src/cli/main.ts`, `bin/rinnegan.js`
- Test: `src/cli/cli.test.ts`

**Interfaces:**
- Consumes: `Rinnegan` library.
- Produces: commander program — `init`, `index`, `status`, `understand <task>`, `search <q>`, `deps <file>`, `refs <symbol>`, `callers <symbol>`, `impact <symbol>`. `--json` flag for LLM-friendly output (vs human ANSI).

- [ ] **Step 1: Write failing test** — invoking `understand` handler on a fixture prints text containing the anchor symbol.
- [ ] **Step 2:** Run test. Expected: FAIL.
- [ ] **Step 3: Implement** CLI; `bin/rinnegan.js` shebang entry.
- [ ] **Step 4:** Run test. Expected: PASS.
- [ ] **Step 5:** Commit `feat(cli): human + --json command surface`.

---

### Task 10: MCP server

**Files:**
- Create: `src/mcp/server.ts`, `src/mcp/instructions.ts`
- Test: `src/mcp/server.test.ts`

**Interfaces:**
- Consumes: `Rinnegan` library, `@modelcontextprotocol/sdk`.
- Produces: MCP server over stdio (SDK handles spec-correct framing — fixes #172). One LISTED tool `understand({task, projectPath?})`; `projectPath` optional, resolved from cwd/single index (fixes #196). Hidden tools (`search,node,deps,refs,callers,impact`) registered behind `RINNEGAN_MCP_TOOLS` env (anti-#1080). `instructions.ts` = initialize text: "call understand first; output is Read-equivalent; only ast_exact is ground truth; do not re-grep."

- [ ] **Step 1: Write failing test** — calling the registered `understand` tool handler with `{task}` on a fixture returns content text with the anchor symbol; tool list length === 1 by default.
- [ ] **Step 2:** Run test. Expected: FAIL.
- [ ] **Step 3: Implement** server + instructions.
- [ ] **Step 4:** Run test. Expected: PASS.
- [ ] **Step 5:** Commit `feat(mcp): single-tool understand server, spec-correct framing`.

---

### Task 11: Determinism + slice-quality eval harness

**Files:**
- Create: `eval/corpus/` (small fixture repo), `eval/determinism.test.ts`, `eval/slice.test.ts`

**Interfaces:**
- Consumes: `Rinnegan`.
- Produces: gate tests — (a) index two fresh runs over the corpus ⇒ identical node/edge dumps (byte-determinism); (b) `understand` output identical across runs; (c) "slice contains the answer": for a known task, output includes the symbols a known change touches; (d) token budget respected.

- [ ] **Step 1: Write failing tests** for (a)-(d).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Build fixtures + make passing (fix any nondeterminism found).
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `test(eval): determinism + slice-quality gates`.

---

## Self-Review

- **Spec coverage:** §4 ingest/parse→T3,T4; §5 graph/provenance→T1,T2; §6 semantic→T6; §7 signal→T7; §8 surfaces→T8,T9,T10; §9 anti-hallucination contract→T7 render + T10 instructions + T11 gates; §11 testing→T11; §2 issue fixes mapped (#1079→T4, #996→T4/T8, #500→T8/T9 deps, #172→T10, #196→T10, #1080→T10). Phase-5 breadth (Python/Go extractors, daemon, watcher) noted as follow-on plan.
- **Placeholders:** algorithmic core (types, store test, LSA/SVD, ranking) given as real code; standard scaffolding/IO modules described with exact interfaces + tests.
- **Type consistency:** `understand(store, semantic, task, opts)` (T7) wrapped by `Rinnegan.understand(task, opts?)` (T8) consumed by CLI (T9) + MCP (T10); `GraphEdge.provenance/confidence/readWrite` consistent T1→T2→T4→T7.

## Follow-on (Phase 5, separate plan)
Python + Go extractors, daemon/socket lifecycle (Win/WSL/SMB-robust), file watcher with staleness banners, more languages, skeletonization tuning.
