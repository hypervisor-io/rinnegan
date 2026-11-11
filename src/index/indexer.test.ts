import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import Database from "better-sqlite3";
import { GraphStore } from "../graph/store.js";
import { Indexer, defaultJobs, resolveJobs } from "./indexer.js";
import type { GraphEdge, GraphNode } from "../core/types.js";

let root: string;
const fixtureDirs: string[] = [];

/** Fresh temp dir seeded with the given relative-path → content files. */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rinnegan-idx-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  fixtureDirs.push(dir);
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rinnegan-idx-"));
  writeFileSync(join(root, "auth.ts"), `export function login(user: string){ return validate(user) } function validate(u: string){ return u.length > 0 }`);
  writeFileSync(join(root, "main.ts"), `function run(){ const r = 1; return r }`);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const d of fixtureDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** One file per parse backend, so a parallel run exercises TS/JS AST, tree-sitter and cross-file imports. */
const POLYGLOT: Record<string, string> = {
  "package.json": JSON.stringify({ name: "poly", main: "./src/index.ts" }),
  "src/index.ts": `import { login } from "./auth.js";\nexport function main() { return login("u") }`,
  "src/auth.ts": `export function login(user: string) { return validate(user) }\nfunction validate(u: string) { return u.length > 0 }`,
  "src/legacy.js": `const { helper } = require("./helper");\nfunction run() { return helper() }\nmodule.exports = { run };`,
  "src/helper.js": `function helper() { return 1 }\nmodule.exports = { helper };`,
  "tools/build.py": `def build(target):\n    return compile_target(target)\n\ndef compile_target(t):\n    return t\n`,
  "scripts/deploy.sh": `#!/usr/bin/env bash\ndeploy() {\n  push_image\n}\npush_image() {\n  echo hi\n}\ndeploy\n`,
  "native/core.rs": `fn helper() -> u32 { 1 }\n\npub fn run() -> u32 { helper() }\n`,
};

/**
 * Full observable index state in a canonical order: two runs that claim to be
 * deterministic must match on every record, not just on counts.
 */
function snapshot(store: GraphStore) {
  const byId = (a: GraphNode, b: GraphNode) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const byEdge = (a: GraphEdge, b: GraphEdge) =>
    [a.source, a.target, a.kind, String(a.line).padStart(9, "0"), String(a.col).padStart(9, "0")].join("\0") <
    [b.source, b.target, b.kind, String(b.line).padStart(9, "0"), String(b.col).padStart(9, "0")].join("\0")
      ? -1
      : 1;
  const files = store.allFilePaths();
  return {
    nodes: [...store.allNodes()].sort(byId),
    edges: [...store.allEdges()].sort(byEdge),
    files,
    metas: files.map((f) => [f, store.getFileMeta(f)] as const),
    imports: files.map((f) => [f, store.getImports(f)] as const),
    roles: [...store.roleByFile()],
    fingerprint: store.fingerprint(),
  };
}

describe("Indexer", () => {
  it("indexes files into the graph", async () => {
    const store = GraphStore.open(":memory:");
    const stats = await new Indexer(store).indexAll(root, { jobs: 1 });
    expect(stats.scanned).toBe(2);
    expect(stats.parsed).toBe(2);
    expect(stats.nodes).toBeGreaterThan(0);
    // login → validate resolves within auth.ts
    expect(store.allEdges().some((e) => e.kind === "calls" && e.provenance === "ast_exact")).toBe(true);
    store.close();
  });

  it("two-gate incremental: re-run with no changes does zero reparse", async () => {
    const dbPath = join(root, ".rinnegan", "graph.db");
    const s1 = GraphStore.open(dbPath);
    await new Indexer(s1).indexAll(root, { jobs: 1 });
    s1.close();

    const s2 = GraphStore.open(dbPath);
    const stats = await new Indexer(s2).indexAll(root, { jobs: 1 });
    expect(stats.parsed).toBe(0);
    expect(stats.skipped).toBe(stats.scanned);
    s2.close();
  });

  it("sync reindexes a changed file", async () => {
    const root = fixture({ "a.ts": "export function one() {}" });
    const store = GraphStore.open(":memory:");
    const ix = new Indexer(store);
    await ix.indexAll(root, { jobs: 1 });
    writeFileSync(join(root, "a.ts"), "export function two() {}");
    const t = Date.now() + 5000;
    utimesSync(join(root, "a.ts"), new Date(t), new Date(t));
    const s = await ix.sync(root);
    expect(s.reindexed).toBe(1);
    expect(store.searchFts("two", 5).length).toBeGreaterThan(0);
    store.close();
  });

  it("sync removes a deleted file and is a no-op when nothing changed", async () => {
    const root = fixture({ "a.ts": "export function one() {}", "b.ts": "export function keep() {}" });
    const store = GraphStore.open(":memory:");
    const ix = new Indexer(store);
    await ix.indexAll(root, { jobs: 1 });
    rmSync(join(root, "a.ts"));
    expect(await ix.sync(root)).toEqual({ reindexed: 0, removed: 1 });
    expect(store.allFilePaths()).toEqual(["b.ts"]);
    expect(await ix.sync(root)).toEqual({ reindexed: 0, removed: 0 }); // no-op sweep
    store.close();
  });

  it("F2: reindexing a file whose export is unchanged preserves inbound resolved cross-file call edges", async () => {
    const root = fixture({
      "a.ts": "export function fn() { return 1 }",
      "b.ts": `import { fn } from "./a";\nexport function useIt() { return fn() }`,
    });
    const store = GraphStore.open(":memory:");
    const ix = new Indexer(store);
    await ix.indexAll(root, { jobs: 1 });

    const callerFiles = (name: string) => {
      const target = store.allNodes().find((n) => n.qualifiedName === name && n.isExported);
      if (!target) return [];
      return store.incoming(target.id, ["calls"]).map((e) => store.getNode(e.source)?.filePath);
    };
    expect(callerFiles("fn")).toContain("b.ts");

    // Touch a.ts's content (export kept) — mtime bump so gate 1 trips too.
    writeFileSync(join(root, "a.ts"), "export function fn() { return 2 }");
    const t = Date.now() + 5000;
    utimesSync(join(root, "a.ts"), new Date(t), new Date(t));
    await ix.sync(root);

    // Before the fix: removeFile(a.ts) destroyed b.ts's resolved calls edge and
    // resolveImports never recreates an already-resolved (non-"unresolved")
    // edge, so b.ts's caller relationship silently vanished.
    expect(callerFiles("fn")).toContain("b.ts");
    store.close();
  });

  it("F2: removing the exported symbol leaves an honest unresolved boundary instead of silent data loss", async () => {
    const root = fixture({
      "a.ts": "export function fn() { return 1 }",
      "b.ts": `import { fn } from "./a";\nexport function useIt() { return fn() }`,
    });
    const store = GraphStore.open(":memory:");
    const ix = new Indexer(store);
    await ix.indexAll(root, { jobs: 1 });

    writeFileSync(join(root, "a.ts"), "function fn() { return 2 }"); // no longer exported
    const t = Date.now() + 5000;
    utimesSync(join(root, "a.ts"), new Date(t), new Date(t));
    await ix.sync(root);

    expect(store.allNodes().some((n) => n.qualifiedName === "fn" && n.isExported)).toBe(false);

    const bEdges = store.allEdges().filter((e) => e.kind === "calls" && store.getNode(e.source)?.filePath === "b.ts");
    const boundary = bEdges.find((e) => e.provenance === "unresolved");
    expect(boundary).toBeTruthy();
    expect(store.getNode(boundary!.target)?.qualifiedName).toBe("<unresolved>.fn");
    store.close();
  });

  it("F2: aliased named import survives reindex of the target file (caller's localName differs from the declared name)", async () => {
    const root = fixture({
      "a.ts": "export function charge() { return 1 }",
      "b.ts": `import { charge as doCharge } from "./a";\nexport function useIt() { return doCharge() }`,
    });
    const store = GraphStore.open(":memory:");
    const ix = new Indexer(store);
    await ix.indexAll(root, { jobs: 1 });

    const callerFiles = (name: string) => {
      const target = store.allNodes().find((n) => n.qualifiedName === name && n.isExported);
      if (!target) return [];
      return store.incoming(target.id, ["calls"]).map((e) => store.getNode(e.source)?.filePath);
    };
    expect(callerFiles("charge")).toContain("b.ts");

    // Touch a.ts's content (export kept) — mtime bump so gate 1 trips too.
    writeFileSync(join(root, "a.ts"), "export function charge() { return 2 }");
    const t = Date.now() + 5000;
    utimesSync(join(root, "a.ts"), new Date(t), new Date(t));
    await ix.sync(root);

    // Before the fix: removeFile(a.ts) named the downgrade placeholder after
    // the TARGET's declared name ("charge"), but resolveImports re-resolves by
    // matching the CALLER's import *localName* ("doCharge") — they never
    // matched, so the edge stayed a permanently-unresolved boundary and b.ts
    // was permanently lost as a caller.
    expect(callerFiles("charge")).toContain("b.ts");
    store.close();
  });

  it("F2: default import under a different local name survives reindex of the target file", async () => {
    const root = fixture({
      "a.ts": "export default function pay() { return 1 }",
      "b.ts": `import settle from "./a";\nexport function useIt() { return settle() }`,
    });
    const store = GraphStore.open(":memory:");
    const ix = new Indexer(store);
    await ix.indexAll(root, { jobs: 1 });

    const callerFiles = (name: string) => {
      const target = store.allNodes().find((n) => n.qualifiedName === name && n.isExported);
      if (!target) return [];
      return store.incoming(target.id, ["calls"]).map((e) => store.getNode(e.source)?.filePath);
    };
    expect(callerFiles("pay")).toContain("b.ts");

    writeFileSync(join(root, "a.ts"), "export default function pay() { return 2 }");
    const t = Date.now() + 5000;
    utimesSync(join(root, "a.ts"), new Date(t), new Date(t));
    await ix.sync(root);

    // Same class of bug as the aliased-named-import case, via the "default"
    // import path: the caller's local name ("settle") never equals the
    // target's declared name ("pay"), so the placeholder must be named from
    // the caller's import row, not `tgt.qualifiedName`.
    expect(callerFiles("pay")).toContain("b.ts");
    store.close();
  });

  it("analyzer-version gate: a stale analyzer version reindexes an unchanged file (hash(code) invalidation)", async () => {
    const root = fixture({ "a.ts": "export function one() {}" });
    const store = GraphStore.open(":memory:");
    const ix = new Indexer(store);
    await ix.indexAll(root, { jobs: 1 });

    // Simulate the file having been indexed by an OLDER analyzer: identical
    // content and mtime, only the analyzer version is stale. A pure
    // content/mtime gate would skip it and keep the old AST output; the
    // analyzer-version gate must force a reparse.
    const meta = store.getFileMeta("a.ts")!;
    store.setFileMeta("a.ts", { ...meta, analyzerVersion: meta.analyzerVersion - 1 });

    expect((await ix.sync(root)).reindexed).toBe(1);
    // once reparsed at the current version, it settles back to a no-op
    expect((await ix.sync(root)).reindexed).toBe(0);
    store.close();
  });

  it("writes one body-token row per file for files_fts", async () => {
    const root = fixture({ "a.ts": "export function turn() { return 1; }" });
    const dbPath = join(root, ".rinnegan", "graph.db");
    const store = GraphStore.open(dbPath);
    const ix = new Indexer(store);
    await ix.indexAll(root, { jobs: 1 });
    expect(store.fileRelevance("turn").get("a.ts")).toBe(1);

    // Unchanged bytes ⇒ no reparse; the row is replaced, never duplicated.
    expect((await ix.sync(root)).reindexed).toBe(0);
    const raw = new Database(dbPath);
    expect(raw.prepare("SELECT count(*) c FROM files_fts WHERE file = ?").get("a.ts")).toEqual({ c: 1 });
    raw.close();
    store.close();
  });

  it("indexAll assigns roles", async () => {
    const root = fixture({
      "package.json": JSON.stringify({ main: "./src/index.ts" }),
      "src/index.ts": "export function main() {}",
      "src/util.ts": "export function u() {}",
      "src/util.test.ts": "import { u } from './util.js'; u();",
    });
    const store = GraphStore.open(":memory:");
    await new Indexer(store).indexAll(root, { jobs: 1 });
    const roles = store.roleByFile();
    expect(roles.get("src/index.ts")).toBe("entrypoint");
    expect(roles.get("src/util.ts")).toBe("library");
    expect(roles.get("src/util.test.ts")).toBe("test");
    expect(roles.get("package.json")).toBe("config");
    store.close();
  });
});

describe("Indexer parallel parsing", () => {
  it("resolveJobs clamps to a usable worker count and keeps the serial fast path", () => {
    expect(resolveJobs(1)).toBe(1);
    expect(resolveJobs(0)).toBe(1);
    expect(resolveJobs(-4)).toBe(1);
    expect(resolveJobs(2.9)).toBe(2);
    expect(resolveJobs(Number.NaN)).toBe(defaultJobs());
    const d = defaultJobs();
    expect(d).toBeGreaterThanOrEqual(1);
    expect(d).toBeLessThanOrEqual(8);
    expect(resolveJobs()).toBe(d);
  });

  it("jobs=1 and jobs=3 produce the exact same graph on a polyglot tree", async () => {
    const root = fixture(POLYGLOT);

    const serial = GraphStore.open(":memory:");
    const serialStats = await new Indexer(serial).indexAll(root, { jobs: 1 });
    const parallel = GraphStore.open(":memory:");
    const parallelStats = await new Indexer(parallel).indexAll(root, { jobs: 3 });

    expect(serialStats.scanned).toBe(Object.keys(POLYGLOT).length);
    expect(serialStats.parsed).toBe(serialStats.scanned);
    expect(parallelStats).toEqual(serialStats);

    // Every record, not just the counts: nodes, edges, file metas, imports, roles, fingerprint.
    expect(snapshot(parallel)).toEqual(snapshot(serial));

    // The fixture really did exercise every parse backend.
    const languages = new Set(serial.allNodes().map((n) => n.language));
    for (const lang of ["typescript", "javascript", "python", "bash", "rust"]) {
      expect(languages.has(lang)).toBe(true);
    }
    serial.close();
    parallel.close();
  });

  it("repeated parallel runs are identical, and the gates still skip an unchanged tree", async () => {
    const root = fixture(POLYGLOT);
    const first = GraphStore.open(":memory:");
    await new Indexer(first).indexAll(root, { jobs: 3 });
    const second = GraphStore.open(":memory:");
    await new Indexer(second).indexAll(root, { jobs: 3 });
    expect(snapshot(second)).toEqual(snapshot(first));

    // Incremental gate 1/2 run before any task is dispatched, so a warm re-index
    // parses nothing at all — in the parallel path too.
    const again = await new Indexer(second).indexAll(root, { jobs: 3 });
    expect(again.parsed).toBe(0);
    expect(again.skipped).toBe(again.scanned);
    expect(snapshot(second).fingerprint).toBe(snapshot(first).fingerprint);
    first.close();
    second.close();
  });

  it("the default worker count still matches the serial graph", async () => {
    const root = fixture(POLYGLOT);
    const store = GraphStore.open(":memory:");
    const stats = await new Indexer(store).indexAll(root);
    const baseline = GraphStore.open(":memory:");
    await new Indexer(baseline).indexAll(root, { jobs: 1 });
    expect(snapshot(store)).toEqual(snapshot(baseline));
    expect(stats.parsed).toBe(stats.scanned);
    store.close();
    baseline.close();
  });

  it("an empty tree indexes cleanly with parallel jobs", async () => {
    const empty = fixture({});
    const store = GraphStore.open(":memory:");
    const stats = await new Indexer(store).indexAll(empty, { jobs: 3 });
    expect(stats).toEqual({ scanned: 0, parsed: 0, skipped: 0, nodes: 0, edges: 0 });
    store.close();
  });
});
