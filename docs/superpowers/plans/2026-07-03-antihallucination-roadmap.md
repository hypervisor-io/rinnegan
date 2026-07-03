# Anti-Hallucination Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the five phases of `docs/superpowers/specs/2026-07-03-roadmap-antihallucination-design.md`: freshness guard, role classification + inventory, `verify` + `lookup`, domains/map + stale-docs + test linkage, corpus fingerprint + CI recipe.

**Architecture:** Everything builds on the existing layers — `GraphStore` (SQLite), `Indexer` (two-gate change detection), `parseFile` extractors, `rankNodes`/`understand` signal engine, CLI (`buildProgram`), MCP (`buildTools`). New modules: `src/ingest/classify.ts` (roles), `src/verify/` (diff parse + overlay verification + lookup), `src/domains/` (label propagation + map rendering). No new dependencies.

**Tech Stack:** TypeScript ESM, better-sqlite3, vitest, commander, @modelcontextprotocol/sdk — all already installed.

## Global Constraints

- Determinism: identical corpus ⇒ byte-identical output. No `Date.now()`/`Math.random()` in any index/output path. Sorted iteration everywhere; lexicographic tie-breaks.
- NO neural embeddings, NO external AI/tokenization API. NO new npm dependencies.
- Every emitted edge carries `provenance` + `confidence`. Only `ast_exact` facts may produce error-severity verify findings.
- `verify` NEVER mutates the on-disk index (rolled-back transaction overlay).
- TDD: failing test first, minimal impl, commit per task. Tests use real fixture dirs (`mkdtempSync`) + real `Rinnegan`/`GraphStore` instances, no mocks — same style as `src/cli/cli.test.ts`.
- Follow existing file conventions: one responsibility per file, terse doc comments explaining *why*.

**Fixture helper used by many tasks below** (each test file can inline it — 6 lines):

```ts
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "rin-"));
  for (const [p, src] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), src);
  }
  return root;
}
```

Note on mtime tests: the indexer's gate 1 compares `mtimeMs` exactly. After rewriting a fixture file, force a distinct mtime with `utimesSync(path, new Date(t), new Date(t))` where `t` is e.g. `Date.now() + 5000` — test-only, never in product code.

---

## Phase 0 — Freshness guard

### Task 1: `Indexer.sync` — one-sweep reconcile (changed + new + deleted)

**Files:**
- Modify: `src/index/indexer.ts`
- Modify: `src/graph/store.ts` (add `allFilePaths`)
- Test: `src/index/indexer.test.ts`

**Interfaces:**
- Consumes: `scanFiles(root)`, `GraphStore.removeFile/getFileMeta`, private `indexOne`.
- Produces: `GraphStore.allFilePaths(): string[]`; `Indexer.sync(root: string): Promise<SyncStats>` with `export interface SyncStats { reindexed: number; removed: number }`. `indexAll` currently never removes deleted files — `sync` is the reconcile primitive; `indexAll` stays as-is (initial build).

- [ ] **Step 1: Failing tests** in `src/index/indexer.test.ts`:

```ts
it("sync reindexes a changed file", async () => {
  const root = fixture({ "a.ts": "export function one() {}" });
  const store = GraphStore.open(":memory:");
  const ix = new Indexer(store);
  await ix.indexAll(root);
  writeFileSync(join(root, "a.ts"), "export function two() {}");
  const t = Date.now() + 5000;
  utimesSync(join(root, "a.ts"), new Date(t), new Date(t));
  const s = await ix.sync(root);
  expect(s.reindexed).toBe(1);
  expect(store.searchFts("two", 5).length).toBeGreaterThan(0);
});
it("sync removes a deleted file and is a no-op when nothing changed", async () => {
  const root = fixture({ "a.ts": "export function one() {}", "b.ts": "export function keep() {}" });
  const store = GraphStore.open(":memory:");
  const ix = new Indexer(store);
  await ix.indexAll(root);
  rmSync(join(root, "a.ts"));
  expect(await ix.sync(root)).toEqual({ reindexed: 0, removed: 1 });
  expect(store.allFilePaths()).toEqual(["b.ts"]);
  expect(await ix.sync(root)).toEqual({ reindexed: 0, removed: 0 }); // no-op sweep
});
```

- [ ] **Step 2:** Run `npx vitest run src/index/indexer.test.ts` — expect FAIL (`sync is not a function`).
- [ ] **Step 3:** Implement. In `store.ts`:

```ts
/** All indexed file paths, sorted. */
allFilePaths(): string[] {
  return (this.stmt(`SELECT path FROM files ORDER BY path`).all() as { path: string }[]).map((r) => r.path);
}
```

In `indexer.ts`:

```ts
export interface SyncStats { reindexed: number; removed: number }

/**
 * Reconcile index with the working tree: reindex changed/new files, remove
 * deleted ones, refresh cross-file edges only if anything moved. Cheap when
 * nothing changed (scan + one stat per file — gate 1).
 */
async sync(root: string): Promise<SyncStats> {
  const scanned = scanFiles(root);
  const onDisk = new Set(scanned.map((f) => f.path));
  let removed = 0;
  for (const path of this.store.allFilePaths()) {
    if (!onDisk.has(path)) { this.store.removeFile(path); removed++; }
  }
  let reindexed = 0;
  for (const f of scanned) if (await this.indexOne(root, f)) reindexed++;
  if (reindexed + removed > 0) this.store.tx(() => resolveImports(this.store));
  return { reindexed, removed };
}
```

- [ ] **Step 4:** Run tests — expect PASS. Also `npm run typecheck`.
- [ ] **Step 5:** Commit `feat(index): Indexer.sync — reconcile changed/new/deleted files in one sweep`.

---

### Task 2: `Rinnegan.refresh` + freshness stamp

**Files:**
- Modify: `src/index.ts`
- Test: `src/library.test.ts`

**Interfaces:**
- Consumes: `Indexer.sync`, `SyncStats`.
- Produces: `Rinnegan.refresh(): Promise<SyncStats>` (invalidates semantic cache when anything changed); `export function freshnessStamp(s: SyncStats): string` returning `"# index: fresh"` or `"# index: N file(s) reindexed, M removed just now"`.

- [ ] **Step 1: Failing tests** in `src/library.test.ts`:

```ts
it("refresh picks up an edit so understand cites current facts", async () => {
  const root = fixture({ "a.ts": "export function oldName() {}" });
  const vx = Rinnegan.open(root, { dbPath: ":memory:" });
  await vx.indexAll();
  writeFileSync(join(root, "a.ts"), "export function newName() {}");
  const t = Date.now() + 5000;
  utimesSync(join(root, "a.ts"), new Date(t), new Date(t));
  const s = await vx.refresh();
  expect(s.reindexed).toBe(1);
  expect(vx.search("newName").length).toBeGreaterThan(0);
  expect(vx.search("oldName").length).toBe(0);
});
it("freshnessStamp wording", () => {
  expect(freshnessStamp({ reindexed: 0, removed: 0 })).toBe("# index: fresh");
  expect(freshnessStamp({ reindexed: 2, removed: 1 })).toBe("# index: 2 file(s) reindexed, 1 removed just now");
});
```

- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement in `src/index.ts`:

```ts
export { type SyncStats } from "./index/indexer.js";

/** Human-readable freshness line prepended to slices by the CLI/MCP surfaces. */
export function freshnessStamp(s: SyncStats): string {
  return s.reindexed + s.removed === 0
    ? "# index: fresh"
    : `# index: ${s.reindexed} file(s) reindexed, ${s.removed} removed just now`;
}

// inside class Rinnegan:
/** Reconcile index with the working tree. Answers must never be stale. */
async refresh(): Promise<SyncStats> {
  const s = await new Indexer(this.store).sync(this.root);
  if (s.reindexed + s.removed > 0) this.semantic = null;
  return s;
}
```

- [ ] **Step 4:** Run tests + typecheck — PASS.
- [ ] **Step 5:** Commit `feat: Rinnegan.refresh + freshnessStamp`.

---

### Task 3: Wire freshness into MCP and CLI

**Files:**
- Modify: `src/mcp/server.ts` (refresh before every tool call; stamp on `understand`)
- Modify: `src/cli/main.ts` (replace `ensureIndexed` body; stamp on `understand`)
- Test: `src/mcp/server.test.ts`, `src/cli/cli.test.ts`

**Interfaces:**
- Consumes: `Rinnegan.refresh()`, `freshnessStamp`.
- Produces: no new API. Behavior: every MCP `CallToolRequest` and every CLI read command answers from a reconciled index; `understand` output line 1 is the freshness stamp.

- [ ] **Step 1: Failing tests.** MCP (`src/mcp/server.test.ts`) — follow the file's existing pattern of exercising `buildTools`/handlers directly:

```ts
it("tool calls see post-edit facts and stamp freshness", async () => {
  const root = fixture({ "a.ts": "export function alpha() {}" });
  const vx = Rinnegan.open(root, { dbPath: ":memory:" });
  await vx.indexAll();
  writeFileSync(join(root, "a.ts"), "export function beta() {}");
  const t = Date.now() + 5000;
  utimesSync(join(root, "a.ts"), new Date(t), new Date(t));
  // dispatch the way the request handler will: refresh first, then handler(args, stamp)
  const stamp = freshnessStamp(await vx.refresh());
  const { all } = buildTools(vx);
  const text = await all.find((t) => t.name === "understand")!.handler({ task: "beta" }, stamp);
  expect(text.split("\n")[0]).toMatch(/^# index: /);
  expect(text).toContain("beta");
  expect(text).not.toContain("alpha");
});
```

CLI (`src/cli/cli.test.ts`): run `understand` via `runCli` against a fixture after an edit; assert first line matches `/^# index: /` and output contains the new symbol.

- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement.
  - `server.ts`: the `CallToolRequestSchema` handler becomes async-refresh-first. `buildTools(vx)` handlers need the stats for the stamp, so refresh in the request handler and pass the stamp down via a closure variable, or simplest: make the handler signature `handler(args, stamp: string)` — only `understand` uses it:

```ts
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = byName.get(req.params.name);
  if (!tool) return { content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }], isError: true };
  const stamp = freshnessStamp(await vx.refresh());
  try {
    return { content: [{ type: "text", text: tool.handler((req.params.arguments ?? {}) as Record<string, unknown>, stamp) }] };
  } catch (e) { /* unchanged error path */ }
});
```

    `understand` handler: `` handler: (a, stamp) => [stamp, vx.understand(...).text].join("\n") ``. Other tools ignore the second param (update `ToolDef.handler` type to `(args, stamp: string) => string`).
  - `main.ts`: `ensureIndexed` becomes:

```ts
async function ensureIndexed(vx: Rinnegan): Promise<SyncStats> {
  if (vx.stats().nodes === 0) { await vx.indexAll(); return { reindexed: 0, removed: 0 }; }
  return vx.refresh();
}
```

    `understand` action prepends `freshnessStamp(s)` to text output (and adds a `fresh` field to the `--json` object). Other read commands just call the new `ensureIndexed` (fresh answers, no stamp).
- [ ] **Step 4:** Run full suite `npm test` — PASS (existing understand-output tests may need the stamp line accounted for; fix assertions, not the stamp).
- [ ] **Step 5:** Commit `feat: freshness guard — MCP/CLI reconcile index before every answer`.

---

## Phase 1 — Role classification + inventory

### Task 4: `classifyFile` — pure classification function

**Files:**
- Create: `src/ingest/classify.ts`
- Test: `src/ingest/classify.test.ts`

**Interfaces:**
- Consumes: nothing (pure function).
- Produces:

```ts
export type FileRole = "entrypoint" | "test" | "config" | "generated" | "vendored" | "doc" | "library";
export interface ClassifyContext {
  entryTargets: Set<string>;   // normalized relative paths named by manifest bin/main/exports
  manifestDirs: Set<string>;   // dirs (relative, "" for root) containing a recognized manifest
}
export function classifyFile(
  path: string,          // relative path
  source: string,        // file content
  language: string,      // from languageOf()
  imports: string[],     // moduleSpecs from ParseResult.imports
  ctx: ClassifyContext,
): FileRole;
export function buildClassifyContext(root: string, manifestPaths: string[]): ClassifyContext;
```

- [ ] **Step 1: Failing tests** in `src/ingest/classify.test.ts` (pure — no fixtures needed except for `buildClassifyContext`). One assertion per rule, precedence checks included:

```ts
const ctx = { entryTargets: new Set(["src/cli/main.ts"]), manifestDirs: new Set([""]) };
const c = (p: string, src = "", lang = "typescript", imp: string[] = []) => classifyFile(p, src, lang, imp, ctx);
it("precedence order", () => {
  expect(c("third_party/x.test.ts")).toBe("vendored");            // vendored beats test
  expect(c("a.test.ts", "// @generated")).toBe("generated");      // generated beats test
});
it("each rule", () => {
  expect(c("third_party/lib.ts")).toBe("vendored");
  expect(c("gen.ts", "// DO NOT EDIT\n")).toBe("generated");
  expect(c("src/a.test.ts")).toBe("test");
  expect(c("tests/helper.ts")).toBe("test");
  expect(c("src/util.ts", "", "typescript", ["vitest"])).toBe("test");
  expect(c("src/cli/main.ts")).toBe("entrypoint");                // manifest target
  expect(c("run.sh", "#!/usr/bin/env bash\n", "bash")).toBe("entrypoint");
  expect(c("index.ts")).toBe("entrypoint");                       // index.* at package root
  expect(c("vite.config.ts")).toBe("config");
  expect(c("package.json", "{}", "manifest")).toBe("config");
  expect(c("README.md", "", "markdown")).toBe("doc");
  expect(c("src/graph/store.ts")).toBe("library");
});
it("buildClassifyContext reads package.json bin/main/exports", () => {
  const root = fixture({ "package.json": JSON.stringify({ main: "./dist/index.js", bin: { x: "./bin/x.js" } }) });
  const ctx2 = buildClassifyContext(root, ["package.json"]);
  expect(ctx2.entryTargets.has("dist/index.js")).toBe(true);
  expect(ctx2.entryTargets.has("bin/x.js")).toBe(true);
  expect(ctx2.manifestDirs.has("")).toBe(true);
});
```

- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement `src/ingest/classify.ts`. Exact rule content (precedence = spec order, first match wins):

```ts
const VENDOR_SEGS = new Set(["vendor", "third_party", "vendored"]);
const GENERATED_RE = /@generated|DO NOT EDIT/;
const TEST_PATH_RE = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[^./]+$|(^|\/)test_[^/]+\.py$|_test\.go$/;
const TEST_FRAMEWORKS = new Set(["vitest", "jest", "@jest/globals", "mocha", "chai", "node:test", "ava", "tap", "supertest", "testing", "pytest", "unittest", "rspec", "minitest"]);
const CONFIG_RE = /(^|\/)(tsconfig[^/]*\.json|\.eslintrc[^/]*|[^/]+\.config\.(js|ts|mjs|cjs|mts)|dockerfile|makefile)$/i;

export function classifyFile(path, source, language, imports, ctx): FileRole {
  const p = path.replace(/\\/g, "/");
  if (p.split("/").some((s) => VENDOR_SEGS.has(s.toLowerCase()))) return "vendored";
  if (GENERATED_RE.test(source.split("\n", 20).join("\n"))) return "generated";
  if (TEST_PATH_RE.test(p) || imports.some((i) => TEST_FRAMEWORKS.has(i))) return "test";
  if (ctx.entryTargets.has(p) || source.startsWith("#!")) return "entrypoint";
  const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (ctx.manifestDirs.has(dir) && /^(main|index)\.[^.]+$/.test(base)) return "entrypoint";
  if (CONFIG_RE.test(p) || language === "manifest" || language === "mcp") return "config";
  if (language === "markdown") return "doc";
  return "library";
}
```

`buildClassifyContext(root, manifestPaths)`: for each `package.json` in `manifestPaths`, `JSON.parse` (try/catch → skip), collect string values of `main`, every value of `bin` (string or object), and every string leaf of `exports`; normalize each with `normalize(join(dirname(manifestPath), value))` and strip a leading `./`; add `dirname(manifestPath)` (as `""` when `"."`) to `manifestDirs` for **all** manifest kinds. Non-`package.json` manifests contribute only `manifestDirs`.
- [ ] **Step 4:** Run tests + typecheck — PASS.
- [ ] **Step 5:** Commit `feat(ingest): deterministic file role classification`.

---

### Task 5: `role` column — schema, migration guard, store accessors

**Files:**
- Modify: `src/graph/schema.sql` (files table gains `role TEXT NOT NULL DEFAULT 'library'`)
- Modify: `src/graph/store.ts`
- Test: `src/graph/store.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `FileMeta` gains `role: string` (default `"library"`); `GraphStore.roleByFile(): Map<string, string>` (sorted by path); constructor migrates old DBs.

- [ ] **Step 1: Failing tests** in `src/graph/store.test.ts`:

```ts
it("persists file role and lists roles", () => {
  const s = GraphStore.open(":memory:");
  s.setFileMeta("a.ts", { hash: "h", mtimeMs: 1, nodeIds: [], role: "test" });
  expect(s.getFileMeta("a.ts")!.role).toBe("test");
  expect(s.roleByFile().get("a.ts")).toBe("test");
});
```

- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement:
  - `schema.sql`: add `role TEXT NOT NULL DEFAULT 'library'` to `CREATE TABLE IF NOT EXISTS files`.
  - `store.ts` constructor, after `this.db.exec(SCHEMA)` — additive migration for DBs created before the column existed:

```ts
const cols = (this.db.pragma("table_info(files)") as { name: string }[]).map((c) => c.name);
if (!cols.includes("role")) this.db.exec(`ALTER TABLE files ADD COLUMN role TEXT NOT NULL DEFAULT 'library'`);
```

  - `FileMeta` gets `role: string`; `setFileMeta` writes it (`INSERT OR REPLACE ... (path,hash,mtime_ms,node_ids,role)`); `getFileMeta` reads it with `?? "library"` fallback;

```ts
roleByFile(): Map<string, string> {
  const rows = this.stmt(`SELECT path, role FROM files ORDER BY path`).all() as { path: string; role: string }[];
  return new Map(rows.map((r) => [r.path, r.role]));
}
```

  - Fix the two existing `setFileMeta` call sites in `indexer.ts` to pass `role: meta?.role ?? "library"` for now (Task 6 sets real roles).
- [ ] **Step 4:** Run store tests + full typecheck — PASS.
- [ ] **Step 5:** Commit `feat(graph): role column on files with additive migration`.

---

### Task 6: Indexer computes roles

**Files:**
- Modify: `src/index/indexer.ts`
- Test: `src/index/indexer.test.ts`

**Interfaces:**
- Consumes: `classifyFile`, `buildClassifyContext`, `ClassifyContext`.
- Produces: `indexAll`/`sync`/`reindexPath` persist real roles. `indexOne` gains a `ctx: ClassifyContext` parameter (private, internal callers only).

- [ ] **Step 1: Failing test:**

```ts
it("indexAll assigns roles", async () => {
  const root = fixture({
    "package.json": JSON.stringify({ main: "./src/index.ts" }),
    "src/index.ts": "export function main() {}",
    "src/util.ts": "export function u() {}",
    "src/util.test.ts": "import { u } from './util.js'; u();",
  });
  const store = GraphStore.open(":memory:");
  await new Indexer(store).indexAll(root);
  const roles = store.roleByFile();
  expect(roles.get("src/index.ts")).toBe("entrypoint");
  expect(roles.get("src/util.ts")).toBe("library");
  expect(roles.get("src/util.test.ts")).toBe("test");
  expect(roles.get("package.json")).toBe("config");
});
```

- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement in `indexer.ts`:
  - `indexAll` and `sync` build context once per sweep: `const ctx = buildClassifyContext(root, files.filter((f) => f.language === "manifest").map((f) => f.path));` and pass to `indexOne`.
  - `reindexPath` builds the same context from a fresh `scanFiles(root)` (a per-save scan is acceptable; watcher already pays a reindex).
  - `indexOne(root, f, ctx)`: after `parseFile`, compute `const role = classifyFile(f.path, content, f.language, res.imports.map((i) => i.moduleSpec), ctx);` and pass `role` in both `setFileMeta` calls (the gate-2 refresh keeps the previous role: `role: meta.role`).
- [ ] **Step 4:** Run indexer tests + full suite — PASS.
- [ ] **Step 5:** Commit `feat(index): persist file roles at index time`.

---

### Task 7: Role-aware ranking

**Files:**
- Modify: `src/signal/rank.ts`, `src/signal/understand.ts`
- Test: `src/signal/understand.test.ts`

**Interfaces:**
- Consumes: `GraphStore.roleByFile()`.
- Produces: `rankNodes(store, ids, relevance, opts?: RankOpts)` with `export interface RankOpts { roles?: Map<string, string>; testIntent?: boolean }`. Exported `ROLE_WEIGHT` table.

- [ ] **Step 1: Failing test** in `src/signal/understand.test.ts` — same symbol name in a test file and a library file; library must outrank test, unless the task mentions tests:

```ts
it("down-ranks test files unless task has test intent", async () => {
  const root = fixture({
    "src/pay.ts": "export function charge() {}",
    "src/pay.test.ts": "export function charge() {}",
  });
  const vx = Rinnegan.open(root, { dbPath: ":memory:" });
  await vx.indexAll();
  const slice = vx.understand("charge payment");
  expect(slice.text.indexOf("src/pay.ts")).toBeLessThan(slice.text.indexOf("src/pay.test.ts"));
  const testSlice = vx.understand("fix the charge test");
  expect(testSlice.text).toContain("src/pay.test.ts");
});
```

- [ ] **Step 2:** Run — FAIL (or passes accidentally — verify by asserting the score ordering via `rankNodes` directly if flaky; ranking assertions must target `rankNodes` output, not rendered text, if the text assertion proves brittle).
- [ ] **Step 3:** Implement. `rank.ts`:

```ts
export const ROLE_WEIGHT: Record<string, number> = {
  entrypoint: 1.1, library: 1, config: 0.7, doc: 0.7, test: 0.5, generated: 0.3, vendored: 0.2,
};
export interface RankOpts { roles?: Map<string, string>; testIntent?: boolean }
```

In `rankNodes`, after `kindW`: `let roleW = ROLE_WEIGHT[opts?.roles?.get(node.filePath) ?? "library"] ?? 1; if (opts?.testIntent && opts.roles?.get(node.filePath) === "test") roleW = 1;` and multiply into `score`. `understand.ts`: `const testIntent = /\b(test|spec|coverage)s?\b/i.test(task); const ranked = rankNodes(store, spine, relevance, { roles: store.roleByFile(), testIntent });`
- [ ] **Step 4:** Full suite — PASS (eval determinism tests in `eval/` must stay green — role weights are deterministic inputs).
- [ ] **Step 5:** Commit `feat(signal): role-aware ranking with test-intent escape hatch`.

---

### Task 8: `inventory` — library API + CLI (JSONL)

**Files:**
- Modify: `src/index.ts`, `src/cli/main.ts`
- Test: `src/library.test.ts`, `src/cli/cli.test.ts`

**Interfaces:**
- Consumes: `roleByFile`, `allNodes`, `incoming`.
- Produces:

```ts
export interface InventoryRow {
  path: string; role: string; language: string;
  symbols: number;        // non-file nodes in this file
  inboundEdges: number;   // edges into this file's nodes from other files' nodes
  orphaned: boolean;      // inboundEdges === 0 && role !== "entrypoint"
}
// on Rinnegan:
inventory(): InventoryRow[];  // sorted by path
```

- [ ] **Step 1: Failing tests.** Library: fixture with an entrypoint importing+calling `used.ts`, plus an `unused.ts`; assert `used.ts` has `inboundEdges > 0`, `unused.ts` is `orphaned: true`, entrypoint is `orphaned: false` despite zero inbound. CLI: `inventory --json` emits one parseable JSON object per line with exactly the six fields; plain mode emits `path  role  language  symbols=N  in=M` and appends ` [orphaned]` when orphaned.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement `Rinnegan.inventory()`:

```ts
inventory(): InventoryRow[] {
  const roles = this.store.roleByFile();
  const nodes = this.store.allNodes();
  const fileOf = new Map(nodes.map((n) => [n.id, n.filePath]));
  const symbols = new Map<string, number>();
  const inbound = new Map<string, number>();
  for (const n of nodes) {
    if (n.kind === "file") continue;
    symbols.set(n.filePath, (symbols.get(n.filePath) ?? 0) + 1);
  }
  for (const e of this.store.allEdges()) {
    const sf = fileOf.get(e.source), tf = fileOf.get(e.target);
    if (sf && tf && sf !== tf) inbound.set(tf, (inbound.get(tf) ?? 0) + 1);
  }
  return [...roles.entries()].map(([path, role]) => {
    const inb = inbound.get(path) ?? 0;
    return {
      path, role,
      language: languageOf(path) ?? "unknown",
      symbols: symbols.get(path) ?? 0,
      inboundEdges: inb,
      orphaned: inb === 0 && role !== "entrypoint",
    };
  });
}
```

(`import { languageOf } from "./ingest/scanner.js"`.) CLI command follows the `status` pattern; `--json` prints `rows.map((r) => JSON.stringify(r)).join("\n")` — JSONL per spec.
- [ ] **Step 4:** Tests + typecheck — PASS.
- [ ] **Step 5:** Commit `feat: rinnegan inventory — roles, inbound edges, orphan detection (JSONL)`.

---

## Phase 2 — `verify` + `lookup`

### Task 9: Unified-diff parsing + in-memory application

**Files:**
- Create: `src/verify/diff.ts`
- Test: `src/verify/diff.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:

```ts
export interface DiffHunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] } // lines keep their +/-/space prefix
export interface DiffFile {
  path: string;                    // post-image path (b/ side), "/dev/null" handling folded into deleted
  hunks: DiffHunk[];
  addedRanges: [number, number][]; // post-image [start,end] line ranges of added lines
  deleted: boolean;                // b-side is /dev/null
  created: boolean;                // a-side is /dev/null
}
export function parseUnifiedDiff(text: string): DiffFile[];
export function applyDiff(original: string, hunks: DiffHunk[]): string;  // throws Error("hunk mismatch at line N") on context mismatch
```

- [ ] **Step 1: Failing tests** — feed a hand-written two-file diff (one edit with two hunks, one new file, one deletion); assert paths, `created`/`deleted`, `addedRanges`, and that `applyDiff` on the original produces the expected post-image byte-for-byte; assert mismatch throws.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement. `parseUnifiedDiff`: split on `/^diff --git |^--- /m` boundaries; read `--- a/X` / `+++ b/Y` (strip `a/`, `b/` prefixes; `/dev/null` sets created/deleted); parse `@@ -o,n +s,m @@` headers; collect hunk lines until next header. `addedRanges`: walk hunk lines tracking the post-image line counter (starts at `newStart`; `+` and space lines advance it), merging consecutive `+` lines into ranges. `applyDiff`: split original into lines; walk hunks in order copying unchanged spans, verifying space/`-` lines match the original (throw on mismatch), emitting space/`+` lines; join with `"\n"`.
- [ ] **Step 4:** Tests — PASS.
- [ ] **Step 5:** Commit `feat(verify): unified diff parser + in-memory applier`.

---

### Task 10: Verify engine — overlay + three checks

**Files:**
- Create: `src/verify/verify.ts`, `src/verify/builtins.ts`
- Modify: `src/index.ts` (expose `Rinnegan.verify`)
- Test: `src/verify/verify.test.ts`

**Interfaces:**
- Consumes: `parseUnifiedDiff`, `applyDiff`, `parseFile`, `resolveImports`, `GraphStore` (tx/removeFile/insertNode/insertEdge/allEdges/getNode/incoming), `roleByFile`.
- Produces:

```ts
export type FindingRule = "unknown-symbol" | "signature-echo" | "blast-radius" | "parse-failure";
export interface Finding { severity: "error" | "warn" | "info"; rule: FindingRule; file: string; line: number; message: string }
export interface VerifyReport { findings: Finding[]; filesChecked: number; skipped: string[] }
export interface VerifyInput { path: string; postImage: string | null /* null = deleted */; addedRanges: [number, number][] }
export function verifyChanges(store: GraphStore, root: string, inputs: VerifyInput[], opts: { allow: Set<string> }): Promise<VerifyReport>;
// on Rinnegan:
verify(diffText: string, opts?: { allow?: string[] }): Promise<VerifyReport>;  // resolves postImage by applyDiff over readFileSync(root/path)
```

`builtins.ts`: `export const BUILTINS: Record<string, Set<string>>` keyed by language — starter sets: `typescript`/`javascript` (`console, JSON, Math, Object, Array, Promise, Set, Map, String, Number, Boolean, Date, RegExp, Error, Symbol, parseInt, parseFloat, isNaN, fetch, setTimeout, setInterval, clearTimeout, clearInterval, structuredClone, require`), `python` (`print, len, range, str, int, float, dict, list, set, tuple, open, isinstance, super, enumerate, zip, map, filter, sorted, getattr, setattr, hasattr, type, Exception, ValueError, TypeError`), `go` (`make, len, cap, new, append, copy, delete, panic, recover, print, println, close, min, max, clear`). Other languages: empty set (their unresolved calls become info, never error — see step 3).

- [ ] **Step 1: Failing tests** in `src/verify/verify.test.ts` — fixture: `src/api.ts` (`export function realFn(a: string) {}`), `src/caller.ts` importing and calling `realFn`, `vendor-free` layout. Cases:

```ts
it("flags a call to a nonexistent symbol as error", async () => {
  // diff adds `notReal();` plus `import { notReal } from "./nowhere.js"` — matches nothing
  const rep = await vx.verify(diffAdding("src/caller.ts", "notReal();"));
  expect(rep.findings.some((f) => f.rule === "unknown-symbol" && f.severity === "error" && /notReal/.test(f.message))).toBe(true);
});
it("echoes ground-truth signature for a resolved call", async () => { /* diff adds realFn("x") → info finding contains "realFn(a: string)" and "src/api.ts:" */ });
it("warns blast radius when a called definition is edited", async () => { /* diff edits realFn's body → warn listing src/caller.ts */ });
it("reports unparseable post-image as parse-failure error", async () => { /* diff makes caller.ts syntactically broken (unclosed brace) — TS parser is lenient, so use a tree-sitter language fixture (e.g. .py with `def broken(:`), and assert parse-failure only when the extractor yields zero nodes for a non-empty source */ });
it("never mutates the on-disk store (rollback proof)", async () => {
  const before = vx.stats();
  await vx.verify(diffAdding("src/caller.ts", "notReal();"));
  expect(vx.stats()).toEqual(before);
});
it("skips vendored/generated files", async () => {
  // fixture also contains third_party/lib.ts; a diff touching it lands in report.skipped with no findings
  const rep = await vx.verify(diffAdding("third_party/lib.ts", "notReal();"));
  expect(rep.skipped).toEqual(["third_party/lib.ts"]);
  expect(rep.findings).toEqual([]);
});
it("--allow suppresses a named unknown symbol", async () => { /* allow: ["notReal"] → no error */ });
```

Include a local `diffAdding(path, line)` helper that fabricates a valid one-hunk unified diff appending `line` to the current fixture file content.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement `verifyChanges`. Core shape — the rolled-back-transaction overlay:

```ts
class Rollback extends Error { constructor(public report: VerifyReport) { super("rollback"); } }

export async function verifyChanges(store, root, inputs, opts): Promise<VerifyReport> {
  const roles = store.roleByFile();
  const skipped = inputs.filter((i) => ["vendored", "generated"].includes(roles.get(i.path) ?? "")).map((i) => i.path);
  const active = inputs.filter((i) => !skipped.includes(i.path));
  // parse post-images OUTSIDE the tx (parseFile is async; better-sqlite3 tx must be sync)
  const parsed = [];
  for (const i of active) {
    if (i.postImage === null) { parsed.push({ input: i, res: null }); continue; }
    const res = await parseFile(i.path, i.postImage, languageOf(i.path) ?? "");
    parsed.push({ input: i, res });
  }
  try {
    store.tx(() => {
      const report = collectFindings(store, parsed, roles, opts);  // mutates graph with post-image, queries, builds findings
      throw new Rollback(report);                                   // better-sqlite3 rolls the tx back on throw
    });
  } catch (e) {
    if (e instanceof Rollback) return e.report;
    throw e;
  }
  throw new Error("unreachable");
}
```

`collectFindings` (sync, inside the tx):
  1. For each parsed file: `store.removeFile(path)`; if deleted → record its previously-known exported defs for blast radius before removal (fetch via `getFileMeta(path).nodeIds` → `getNode` BEFORE `removeFile`); else insert post-image nodes/edges/imports. Then `resolveImports(store)` once.
  2. **parse-failure**: post-image non-empty but extractor produced zero non-file nodes AND zero edges for a language with a real extractor → error finding. (TS parser is error-tolerant; this rule mostly fires for tree-sitter/bespoke languages.)
  3. **unknown-symbol** (error): for `calls` edges with `provenance === "unresolved"` whose source node lives in a changed file and whose `line` falls inside that file's `addedRanges`: `name = target.qualifiedName.replace(/^<unresolved>\./, "")`. Error only if ALL hold: name ∉ file imports' localNames; no node in graph has `qualifiedName === name` or `.endsWith("." + name)`; name ∉ `BUILTINS[language]`; name ∉ `opts.allow`; the language HAS a builtins entry (languages without one produce `info` instead — honesty rule: half-known languages must not block). Message: `` `call to '${name}' — no such symbol exists in this codebase (possible hallucination)` ``.
  4. **signature-echo** (info): `calls` edges from changed files inside addedRanges with provenance `ast_exact`/`ast_inferred`: message `` `${name} is ${callee.signature ?? callee.qualifiedName} — ${callee.filePath}:${callee.startLine}` ``.
  5. **blast-radius** (warn): definitions (kind in function/method/class/interface) in changed files whose `[startLine, endLine]` intersects an added range (or all exported defs of a deleted file): callers = `store.incoming(id, ["calls"])` from files not in the changed set → warn message `` `${def.qualifiedName} changed — ${n} caller(s) outside this diff: ${first3.map(c => c.filePath + ":" + c.startLine).join(", ")}` ``.
  Findings sorted by (file, line, rule) — deterministic. `Rinnegan.verify(diffText, opts)`: `parseUnifiedDiff` → build `VerifyInput[]` (postImage: created → applyDiff over `""`; deleted → null; else applyDiff over `readFileSync(join(root, path), "utf8")`; wrap applyDiff/read errors as parse-failure findings) → merge `opts.allow` with lines of `.rinnegan-allow` at root if present (one name per line, `#` comments) → `verifyChanges`.
- [ ] **Step 4:** Tests + full suite — PASS. The rollback-proof assertion (`stats` unchanged) is the non-negotiable one.
- [ ] **Step 5:** Commit `feat(verify): graph-native fact-check of diffs — unknown symbols, signature echo, blast radius`.

---

### Task 11: `verify` CLI — `--staged`, `--diff`, exit codes

**Files:**
- Modify: `src/cli/main.ts`
- Test: `src/cli/cli.test.ts`

**Interfaces:**
- Consumes: `Rinnegan.verify`.
- Produces: `rinnegan verify [--staged] [--diff <file|->] [--allow <names...>] [--json]`. Text output one finding per line: `<file>:<line>  <severity>  <rule>  <message>`; summary line `N error(s), M warning(s), K info`. Process exit code 1 iff ≥1 error finding. `--staged` obtains addedRanges from `execFileSync("git", ["-C", root, "diff", "--cached", "--unified=0"])` and each post-image directly from the git index via `execFileSync("git", ["-C", root, "show", `:${path}`])` (no applier needed — the index IS the post-image; deleted files: `git show` fails → `postImage: null`). Outside a git repo, `--staged` errors with `not a git repository — use --diff <patch>`.

- [ ] **Step 1: Failing tests** (CLI level, following `cli.test.ts` conventions): `verify --diff bad.patch` where the patch calls a nonexistent symbol → output contains `unknown-symbol`, `runCli` surfaces exit intent (commander action should `process.exitCode = 1`, assert on that rather than a hard `process.exit`); happy patch → `0 error(s)` and exitCode stays 0; `--staged` outside a repo (fixture dir has no .git) → error message names `--diff`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement the command (mirror `understand`'s structure; `--diff -` reads stdin via `readFileSync(0, "utf8")`). For `--staged`, build `VerifyInput[]` directly: parse the cached diff for paths + addedRanges, fetch each post-image via `git show :<path>` (deleted files: `git show` fails → postImage null), and call a second exported form `Rinnegan.verifyInputs(inputs, opts)` that skips the applier (add this thin public wrapper around `verifyChanges` in the same task). Set `process.exitCode = 1` when errors exist — never call `process.exit()` (breaks tests).
- [ ] **Step 4:** Tests — PASS.
- [ ] **Step 5:** Commit `feat(cli): rinnegan verify — staged/diff modes, exit 1 on unknown symbols`.

---

### Task 12: `lookup` — exact fact or explicit NOT FOUND

**Files:**
- Modify: `src/index.ts`, `src/cli/main.ts`
- Test: `src/library.test.ts`, `src/cli/cli.test.ts`

**Interfaces:**
- Consumes: `allNodes`, `searchFts`, `incoming`.
- Produces:

```ts
export type LookupResult =
  | { found: true; node: GraphNode; callers: number }
  | { found: false; message: string; suggestions: { name: string; file: string; line: number }[] };
// on Rinnegan:
lookup(name: string): LookupResult;
// rendering helper (shared by CLI + MCP):
export function renderLookup(r: LookupResult): string;
```

Exact-match rule (this is NOT `resolveSymbol` — no FTS fallback into a false positive): candidates = nodes where `qualifiedName === name` OR `qualifiedName.endsWith("." + name)`, excluding kinds `file`/`import`/`unresolved`; pick deterministically by (exact match first, then lowest `id`). Not found → `message` is exactly:
`NOT FOUND — no symbol named '<name>' exists in this codebase. Do not invent it.`
`suggestions` = top 3 from `searchFts(name, 3)` mapped to `{ name: qualifiedName, file: filePath, line: startLine }`.
`renderLookup`: found → `` `${node.qualifiedName}  [${node.kind}]\n${node.signature ?? "(no signature)"}\n${node.filePath}:${node.startLine}\ncallers: ${callers}` ``; not found → message + `did you mean:` lines (omit section when no suggestions).

- [ ] **Step 1: Failing tests:** found case returns signature + location + caller count; absent case's text contains the exact NOT FOUND sentence and ≤3 suggestions; CLI `lookup <name>` prints `renderLookup` output and `--json` prints the `LookupResult`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement (`callers = this.store.incoming(node.id, ["calls"]).length`). CLI command follows `callers` pattern.
- [ ] **Step 4:** Tests — PASS.
- [ ] **Step 5:** Commit `feat: rinnegan lookup — exact symbol facts with explicit NOT FOUND negatives`.

---

### Task 13: MCP — expose `verify` + `lookup`, update instructions

**Files:**
- Modify: `src/mcp/server.ts`, `src/mcp/instructions.ts`
- Test: `src/mcp/server.test.ts`

**Interfaces:**
- Consumes: `Rinnegan.verify`, `Rinnegan.lookup`, `renderLookup`.
- Produces: default `listed` set becomes `[understand, lookup, verify]` (the `RINNEGAN_MCP_TOOLS=all` env still exposes everything). `verify` tool input: `{ diff: string }` (required) — returns the text report; `lookup` input: `{ name: string }` (required).

- [ ] **Step 1: Failing tests:** list-tools returns the three names; `lookup` tool round-trips a found + a NOT FOUND case; `verify` tool flags an unknown symbol from a diff string. Note: `ToolDef.handler` is sync (`=> string`) but `verify` is async — widen the type to `=> string | Promise<string>` and `await` it in the request handler (assert existing tools still pass).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement tools (descriptions matter — they are agent-facing):
  - `lookup`: `"Exact symbol lookup. Returns the ground-truth signature and location, or an explicit NOT FOUND. Call before referencing any symbol you have not seen in a slice."`
  - `verify`: `"Fact-check a unified diff against the code graph BEFORE applying it: unknown symbols (hallucinations), real signatures of called functions, blast radius of edited definitions."`
  - `SERVER_INSTRUCTIONS` in `instructions.ts` gains the loop sentence: `Recommended loop: understand → lookup anything you are about to call → write patch → verify the patch → apply.`
- [ ] **Step 4:** Tests — PASS.
- [ ] **Step 5:** Commit `feat(mcp): lookup + verify tools — the anti-hallucination loop`.

---

## Phase 3 — Domains, map, stale-docs, test linkage

### Task 14: Domain computation — deterministic label propagation

**Files:**
- Create: `src/domains/domains.ts`
- Test: `src/domains/domains.test.ts`

**Interfaces:**
- Consumes: `GraphStore.allNodes/allEdges/roleByFile`.
- Produces:

```ts
export interface Domain { name: string; files: string[]; entrypoints: string[] }        // files sorted
export interface DomainEdge { from: string; to: string; weight: number }                 // between domain names
export function computeDomains(store: GraphStore): { domains: Domain[]; edges: DomainEdge[] };
```

Algorithm (spec-fixed, no free choices left to the implementer):
1. File graph: for every edge whose source-node file ≠ target-node file, `weight[fileA][fileB]++` (undirected for propagation; keep directed counts for `DomainEdge`). Exclude pseudo-files `<packages>` and paths starting `<`.
2. Seed label of file = first path segment (`"src"` → files directly at root get label `"."`). Files under `src/` seed by their SECOND segment when the repo has a single top-level source dir (rule: if >60% of code files share one first segment, seed by segment 2 within it) — this is what makes `src/graph`, `src/cli` separate candidate domains.
3. Propagation rounds (max 10): iterate files in sorted path order; new label = the label with max summed neighbor weight; ties broken by lexicographically smallest label; a file with no neighbors keeps its seed. Stop early when a full round changes nothing.
4. Domains = group by final label, sorted by name; `name` = longest common directory prefix of member files (fallback: the label); `entrypoints` = member files with role `entrypoint`.
5. `edges` = directed file-graph weights aggregated between distinct final domains, sorted by (from, to).

- [ ] **Step 1: Failing tests:** fixture with `src/auth/{login.ts,token.ts}` (login imports token), `src/billing/charge.ts` (imports `src/auth/token.ts`), root `main.ts` (entrypoint, imports both) — assert: two-plus domains with auth files grouped together; billing→auth edge present with weight ≥1; byte-identical result across two `computeDomains` calls on a rebuilt store (determinism).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement exactly the five numbered rules. Keep it one file, ~120 lines; plain `Map<string, Map<string, number>>` adjacency.
- [ ] **Step 4:** Tests — PASS.
- [ ] **Step 5:** Commit `feat(domains): deterministic label-propagation domain detection`.

---

### Task 15: `rinnegan map` — markdown + mermaid + JSON

**Files:**
- Create: `src/domains/render.ts`
- Modify: `src/index.ts` (add `Rinnegan.map()`), `src/cli/main.ts`, `src/mcp/server.ts` (add `map` to listed tools)
- Test: `src/domains/render.test.ts`, `src/cli/cli.test.ts`

**Interfaces:**
- Consumes: `computeDomains`, `rankNodes`-style centrality (`store.incoming(id, ["calls"]).length`).
- Produces:

```ts
export interface MapResult { domains: (Domain & { topSymbols: { name: string; file: string; line: number }[] })[]; edges: DomainEdge[] }
// on Rinnegan:
map(): MapResult;   // topSymbols = per-domain top 5 non-file nodes by incoming-call count, ties by id
export function renderMapMarkdown(m: MapResult): string;
export function renderMapMermaid(m: MapResult): string;   // flowchart LR; domain names sanitized to [A-Za-z0-9_]
```

Markdown shape per domain: `## <name>` / `entrypoints: a, b` (omit line when none) / `top symbols:` bullet list `- <qualifiedName> — <file>:<line>` / blank line; then `## dependencies` section with lines `auth → billing (3)`.

- [ ] **Step 1: Failing tests:** markdown contains each domain header, the entrypoint line, arrow lines with weights; mermaid output starts `flowchart LR` and has one edge per DomainEdge; CLI `map` prints markdown, `map --mermaid` prints mermaid, `map --json` round-trips. MCP `map` tool (no input) returns markdown.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement render + `Rinnegan.map()` + CLI command (auto-index via `ensureIndexed` like the others) + MCP tool with description `"Architecture map: domains, entrypoints, top symbols, inter-domain dependencies. Call before understand --scope on large repos."` Listed set becomes `[understand, lookup, verify, map]`.
- [ ] **Step 4:** Tests — PASS.
- [ ] **Step 5:** Commit `feat: rinnegan map — domain architecture overview (md/mermaid/json)`.

---

### Task 16: `understand --scope <domain>`

**Files:**
- Modify: `src/signal/understand.ts`, `src/index.ts`, `src/cli/main.ts`, `src/mcp/server.ts`
- Test: `src/signal/understand.test.ts`

**Interfaces:**
- Consumes: `computeDomains`.
- Produces: `UnderstandOpts` gains `scopeFiles?: Set<string>`; `Rinnegan.understand(task, { scope?: string, ...})` resolves a domain name to its file set (unknown scope → `throw new Error(\`unknown domain '<x>' — available: a, b, c\`)`); CLI/MCP pass `scope` through.

- [ ] **Step 1: Failing tests:** two-domain fixture; `understand("shared term", { scope: "auth" })` slice contains only auth-domain files; unknown scope error lists available domains.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement: in `understand()`, when `scopeFiles` present — filter FTS/semantic seed ids to nodes whose `filePath` ∈ set, and in `extractSpine` expansion drop nodes outside the set (pass the filter into `extractSpine` as an optional `include?: (n: GraphNode) => boolean` opt — one added parameter, default always-true). `Rinnegan.understand` builds `scopeFiles` from `computeDomains` when `opts.scope` is a string. CLI `-s, --scope <domain>` option; MCP `understand` input schema gains optional `scope` string.
- [ ] **Step 4:** Full suite — PASS.
- [ ] **Step 5:** Commit `feat(signal): understand --scope <domain> — domain-restricted slices`.

---

### Task 17: Stale-doc detection

**Files:**
- Modify: `src/parse/special/docs.ts` (inline-code mentions), `src/index.ts`, `src/cli/main.ts`
- Test: `src/parse/special/special.test.ts` (extractor), `src/library.test.ts` (staleDocs)

**Interfaces:**
- Consumes: docs extractor pipeline; graph queries.
- Produces: `extractDocs` additionally emits, per unique inline-code identifier: an unresolved node (`qualifiedName: "<docref>." + name`, kind `unresolved`) plus a `references` edge `provenance: "heuristic", confidence: 0.4, resolver: "docs-inline"`. `Rinnegan.staleDocs(): { docPath: string; line: number; name: string }[]` — docs-inline mentions whose name matches no real node. CLI: `rinnegan docs --stale [--json]`.

Mention extraction rules (all must hold): matches `` /`([A-Za-z_$][A-Za-z0-9_$.]{2,})`/g ``; line is NOT inside a fenced code block (track ``` fence state per file); name is not a bare filename (skip when it contains `/` or ends in a known extension); dedupe per file.

- [ ] **Step 1: Failing tests.** Extractor: markdown with `` `realFn` `` on a prose line, `` `fenced` `` inside a code fence, and `` `a/b.ts` `` — exactly one `docs-inline` edge (for `realFn`). staleDocs: fixture where `docs/x.md` mentions `` `realFn` `` (exists in `src/api.ts`) and `` `goneFn` `` (doesn't) → exactly one stale row `{ docPath: "docs/x.md", name: "goneFn" }`. CLI `docs --stale` prints `docs/x.md:<line>  mentions 'goneFn' — no such symbol`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement. `staleDocs()`: scan `allEdges()` for `resolver === "docs-inline"`; `name = target.qualifiedName.replace(/^<docref>\./, "")`; stale iff no node (kinds excluding file/import/unresolved) has `qualifiedName === name || qualifiedName.endsWith("." + name)`; sort by (docPath, line, name).
- [ ] **Step 4:** Full suite — PASS (docs fixture files in other tests must not accidentally gain edges that break counts — adjust assertions if they do).
- [ ] **Step 5:** Commit `feat(docs): inline-code mention edges + rinnegan docs --stale`.

---

### Task 18: Test linkage — `rinnegan tests` + covered-by in slices

**Files:**
- Modify: `src/index.ts`, `src/cli/main.ts`, `src/signal/harmonic.ts`, `src/signal/understand.ts`
- Test: `src/library.test.ts`, `src/signal/understand.test.ts`

**Interfaces:**
- Consumes: roles (Task 6), `incoming(id, ["calls"])`.
- Produces: `Rinnegan.testsFor(symbol: string, depth = 2): GraphNode[]` — BFS up incoming `calls` edges to `depth`, keep nodes whose file role is `test`, sorted by (filePath, startLine). CLI `rinnegan tests <symbol>` (prints `file:line  qualifiedName`, `(none)` fallback). `buildHarmonic` opts gain `roles?: Map<string, string>`; each DETAIL fact for a def-kind node gets one appended line `  covered-by: <up to 3 test file paths, comma-joined>` or `  covered-by: (none)` — computed from depth-1 incoming calls from test-role files (cheap; the `tests` command owns the transitive view).

- [ ] **Step 1: Failing tests:** fixture `src/pay.ts` (charge), `src/pay.test.ts` (imports + calls charge). `testsFor("charge")` returns the test-file caller; CLI prints its location; `understand("charge")` DETAIL section contains `covered-by: src/pay.test.ts`; an uncalled symbol's fact shows `covered-by: (none)`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement (`testsFor` mirrors `impact`'s BFS shape; harmonic passes roles through from `understand` which already fetched `roleByFile()` in Task 7 — reuse that map, fetch once).
- [ ] **Step 4:** Full suite — PASS.
- [ ] **Step 5:** Commit `feat: test linkage — rinnegan tests <symbol> + covered-by lines in slices`.

---

## Phase 4 — Corpus fingerprint + CI recipe

### Task 19: Fingerprint in status

**Files:**
- Modify: `src/graph/store.ts`, `src/index.ts`, `src/cli/main.ts`
- Test: `src/graph/store.test.ts`, `src/cli/cli.test.ts`

**Interfaces:**
- Consumes: `files` table.
- Produces: `GraphStore.fingerprint(): string` — `sha256` over `path + "\0" + hash + "\n"` for all files sorted by path (empty index → sha256 of empty string); `Rinnegan.stats()` return gains `fingerprint: string`; CLI `status` prints `nodes=… edges=… files=… fingerprint=<first 16 hex chars>` (full value in `--json`).

- [ ] **Step 1: Failing tests:** fingerprint stable across two `indexAll` runs on an unchanged fixture; changes when any file's content changes; store-level unit test pins the algorithm (two files inserted in either order → same fingerprint).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement:

```ts
/** Corpus identity: same fingerprint ⇒ same index bytes (determinism promise). */
fingerprint(): string {
  const h = createHash("sha256");
  const rows = this.stmt(`SELECT path, hash FROM files ORDER BY path`).all() as { path: string; hash: string }[];
  for (const r of rows) h.update(`${r.path}\0${r.hash}\n`);
  return h.digest("hex");
}
```

- [ ] **Step 4:** Tests — PASS.
- [ ] **Step 5:** Commit `feat: corpus fingerprint in status — deterministic index identity`.

---

### Task 20: README — sharing recipe + new commands

**Files:**
- Modify: `README.md`

**Interfaces:** none (docs).

- [ ] **Step 1:** Add a `## Sharing the index (CI cache)` section: the index is one file (`.rinnegan/graph.db`); GitHub Actions example — `actions/cache` with `path: .rinnegan`, `key: rinnegan-${{ runner.os }}-${{ github.sha }}`, `restore-keys: rinnegan-${{ runner.os }}-`, then `rinnegan index` (two-gate detection makes warm updates cheap); `rinnegan status --json | jq .fingerprint` verifies two machines hold the same corpus. State the decision: no S3/git backend — copy the file.
- [ ] **Step 2:** Update the command list + MCP description: `inventory`, `verify`, `lookup`, `map`, `tests`, `docs --stale`, `understand --scope`; MCP now lists `understand, lookup, verify, map`; add the agent loop sentence (understand → lookup → patch → verify → apply).
- [ ] **Step 3:** Add a `## Pre-commit gate` subsection with the one-line hook from the spec:

```bash
echo 'rinnegan verify --staged || exit 1' >> .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
```

  plus one sentence: only unknown-symbol errors block; signature echoes and blast-radius warnings inform but never fail the commit.
- [ ] **Step 4:** Proofread rendered markdown (`git diff` review), commit `docs: README — new commands, MCP loop, pre-commit gate, CI cache recipe`.

---

## Final gate (after all phases)

- [ ] `npm test` — full suite green, including `eval/determinism.test.ts` (byte-identical output is the product promise; role weights, stamps, and domains are all deterministic inputs so this must hold).
- [ ] `npm run typecheck` + `npm run build` — clean.
- [ ] Manual smoke on this repo itself: `rinnegan inventory`, `rinnegan map`, `rinnegan lookup rankNodes`, `rinnegan lookup nothingBurger` (NOT FOUND), `git diff | rinnegan verify --diff -`.
