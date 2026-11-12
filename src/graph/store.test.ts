import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { GraphStore } from "./store.js";

describe("GraphStore", () => {
  it("persists provenance + retrieves edges and fts", () => {
    const g = GraphStore.open(":memory:");
    g.insertNode({ id: "a", kind: "function", qualifiedName: "login", filePath: "a.ts", language: "ts", startLine: 1, endLine: 3 });
    g.insertNode({ id: "b", kind: "function", qualifiedName: "userSession", filePath: "a.ts", language: "ts", startLine: 5, endLine: 9 });
    g.insertEdge({ source: "a", target: "b", kind: "calls", line: 2, col: 1, provenance: "ast_exact", confidence: 1, resolver: "ts", readWrite: "call" });

    expect(g.outgoing("a")[0].provenance).toBe("ast_exact");
    expect(g.outgoing("a")[0].readWrite).toBe("call");
    expect(g.incoming("b")[0].source).toBe("a");
    expect(g.searchFts("login", 5).map((n) => n.id)).toContain("a");
    // camelCase split: "userSession" indexed under "session"
    expect(g.searchFts("session", 5).map((n) => n.id)).toContain("b");
    g.close();
  });

  it("removeFile prunes nodes and dangling edges", () => {
    const g = GraphStore.open(":memory:");
    g.insertNode({ id: "x", kind: "function", qualifiedName: "f", filePath: "x.ts", language: "ts", startLine: 1, endLine: 2 });
    g.insertNode({ id: "y", kind: "function", qualifiedName: "g", filePath: "y.ts", language: "ts", startLine: 1, endLine: 2 });
    g.insertEdge({ source: "y", target: "x", kind: "calls", line: 1, col: 1, provenance: "ast_exact", confidence: 1, resolver: "ts" });
    g.setFileMeta("x.ts", { hash: "h", mtimeMs: 1, nodeIds: ["x"], role: "library" });

    g.removeFile("x.ts");
    expect(g.getNode("x")).toBeUndefined();
    expect(g.incoming("x")).toHaveLength(0);
    expect(g.outgoing("y").filter((e) => e.target === "x")).toHaveLength(0);
    g.close();
  });

  it("removeFile downgrades a resolved cross-file 'calls' edge back to an unresolved boundary instead of deleting it (F2)", () => {
    const g = GraphStore.open(":memory:");
    g.insertNode({ id: "a_fn", kind: "function", qualifiedName: "charge", filePath: "a.ts", language: "ts", startLine: 1, endLine: 2, isExported: true });
    g.insertNode({ id: "b_fn", kind: "function", qualifiedName: "useIt", filePath: "b.ts", language: "ts", startLine: 1, endLine: 2 });
    // Simulates the post-resolveImports state: a resolved cross-file call.
    g.insertEdge({ source: "b_fn", target: "a_fn", kind: "calls", line: 5, col: 3, provenance: "ast_inferred", confidence: 0.9, resolver: "ts-import", readWrite: "call", metadata: { crossFile: true, module: "./a" } });
    g.setFileMeta("a.ts", { hash: "h", mtimeMs: 1, nodeIds: ["a_fn"], role: "library" });
    g.setFileMeta("b.ts", { hash: "h", mtimeMs: 1, nodeIds: ["b_fn"], role: "library" });

    g.removeFile("a.ts");

    const downgraded = g.outgoing("b_fn").find((e) => e.kind === "calls");
    expect(downgraded).toBeTruthy();
    expect(downgraded!.provenance).toBe("unresolved");
    const placeholder = g.getNode(downgraded!.target);
    expect(placeholder?.qualifiedName).toBe("<unresolved>.charge");
    expect(placeholder?.filePath).toBe("b.ts"); // lives in the caller's file, not the removed file
    expect(placeholder?.kind).toBe("unresolved");
    // Placeholder must go through insertNode so nodes_fts stays consistent.
    expect(g.searchFts("charge", 5).map((n) => n.id)).toContain(downgraded!.target);
    g.close();
  });

  it("removeFile does not wrongly downgrade non-'calls' edges into a shared pseudo node (e.g. manifest package hub)", () => {
    const g = GraphStore.open(":memory:");
    const hubId = "hub_lodash";
    g.insertNode({ id: hubId, kind: "module", qualifiedName: "lodash", filePath: "<packages>", language: "package", startLine: 1, endLine: 1 });
    g.insertNode({ id: "manifestA", kind: "file", qualifiedName: "<file>", filePath: "a/package.json", language: "manifest", startLine: 1, endLine: 1 });
    g.insertNode({ id: "manifestB", kind: "file", qualifiedName: "<file>", filePath: "b/package.json", language: "manifest", startLine: 1, endLine: 1 });
    g.insertEdge({ source: "manifestA", target: hubId, kind: "references", line: 1, col: 1, provenance: "ast_exact", confidence: 1, resolver: "manifest-dep", metadata: { dependsOn: true } });
    g.insertEdge({ source: "manifestB", target: hubId, kind: "references", line: 1, col: 1, provenance: "ast_exact", confidence: 1, resolver: "manifest-dep", metadata: { dependsOn: true } });
    // Mirrors indexer.ts: setFileMeta's node_ids = res.nodes.map(id), which
    // includes the shared hub node under whichever manifest's extraction ran.
    g.setFileMeta("a/package.json", { hash: "h", mtimeMs: 1, nodeIds: ["manifestA", hubId], role: "config" });
    g.setFileMeta("b/package.json", { hash: "h", mtimeMs: 1, nodeIds: ["manifestB"], role: "config" });

    g.removeFile("a/package.json");

    // Pre-existing (out-of-scope) collateral loss of the hub node itself is
    // unchanged by this fix — but critically, B's edge must NOT be rewritten
    // into a bogus "<unresolved>.lodash" placeholder: only "calls" edges are
    // eligible for downgrade, "references"/depends_on edges are not.
    expect(g.getNode(hubId)).toBeUndefined();
    expect(g.outgoing("manifestB")).toHaveLength(0);
    expect(g.allNodes().some((n) => n.qualifiedName.startsWith("<unresolved>"))).toBe(false);
    g.close();
  });

  it("persists file role and lists roles", () => {
    const s = GraphStore.open(":memory:");
    s.setFileMeta("a.ts", { hash: "h", mtimeMs: 1, nodeIds: [], role: "test" });
    expect(s.getFileMeta("a.ts")!.role).toBe("test");
    expect(s.roleByFile().get("a.ts")).toBe("test");
    s.close();
  });

  it("fingerprint pins the sha256(path + NUL + hash + NUL + analyzerVersion + NL, sorted by path) algorithm and is insertion-order independent", () => {
    const line = (p: string, h: string, v: number) => `${p}\0${h}\0${v}\n`;
    const expected = createHash("sha256").update(line("a.ts", "h1", 1)).update(line("b.ts", "h2", 1)).digest("hex");

    const forward = GraphStore.open(":memory:");
    forward.setFileMeta("a.ts", { hash: "h1", mtimeMs: 1, nodeIds: [], role: "library", analyzerVersion: 1 });
    forward.setFileMeta("b.ts", { hash: "h2", mtimeMs: 1, nodeIds: [], role: "library", analyzerVersion: 1 });
    expect(forward.fingerprint()).toBe(expected);
    forward.close();

    const reverse = GraphStore.open(":memory:");
    reverse.setFileMeta("b.ts", { hash: "h2", mtimeMs: 1, nodeIds: [], role: "library", analyzerVersion: 1 });
    reverse.setFileMeta("a.ts", { hash: "h1", mtimeMs: 1, nodeIds: [], role: "library", analyzerVersion: 1 });
    expect(reverse.fingerprint()).toBe(expected);
    reverse.close();
  });

  it("fingerprint of an empty index is sha256 of empty input", () => {
    const s = GraphStore.open(":memory:");
    expect(s.fingerprint()).toBe(createHash("sha256").update("").digest("hex"));
    s.close();
  });
});

describe("GraphStore files_fts (path-aware file prior)", () => {
  it("scores the file whose BODY holds the rare token, normalized to 0..1", () => {
    const g = GraphStore.open(":memory:");
    g.setFileTokens("runtime/io/driver.rs", "the epoll driver turns io resources");
    g.setFileTokens("logging/admin.ts", "logging admin filters request context");
    const rel = g.fileRelevance("epoll io");
    expect(rel.get("runtime/io/driver.rs")).toBe(1); // best file normalizes to exactly 1
    expect(rel.has("logging/admin.ts")).toBe(false); // no path or body hit ⇒ absent
    for (const v of rel.values()) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(g.fileRelevance("nothingmatcheshere")).toEqual(new Map());
    g.close();
  });

  it("weights PATH tokens above body tokens, so naming the concept in the path wins", () => {
    const g = GraphStore.open(":memory:");
    // Identical bodies that say nothing about promql: only the PATH knows.
    g.setFileTokens("promql/engine.go", "the evaluator walks the statement tree");
    g.setFileTokens("docs/notes.md", "the evaluator walks the statement tree");
    expect(g.fileRelevance("promql").get("promql/engine.go")).toBe(1);
    expect(g.fileRelevance("promql").has("docs/notes.md")).toBe(false);
    // A directory component counts the same as a basename component.
    expect(g.fileRelevance("engine").get("promql/engine.go")).toBe(1);

    // Same single occurrence in the path vs in the body: the path wins.
    const h = GraphStore.open(":memory:");
    h.setFileTokens("promql/engine.go", "walks the expression tree");
    h.setFileTokens("misc/helper.go", "promql walks the expression tree");
    const pathWins = h.fileRelevance("promql");
    expect(pathWins.get("promql/engine.go")).toBe(1);
    expect(pathWins.get("misc/helper.go")).toBeLessThan(1);
    g.close();
    h.close();
  });

  it("indexes identifier MORPHOLOGY so prose verbs meet their identifiers", () => {
    const g = GraphStore.open(":memory:");
    g.insertNode({ id: "n_eval", kind: "method", qualifiedName: "eval", filePath: "promql/engine.go", language: "go", startLine: 2669, endLine: 2680 });
    g.insertNode({ id: "n_register", kind: "function", qualifiedName: "register", filePath: "router/registry.ts", language: "ts", startLine: 3, endLine: 5 });
    g.insertNode({ id: "n_cat", kind: "function", qualifiedName: "catalog", filePath: "shop/catalog.ts", language: "ts", startLine: 1, endLine: 2 });

    // prose → identifier (and back) must both hit
    expect(g.searchFts("evaluate", 5).map((n) => n.id)).toContain("n_eval");
    expect(g.searchFts("evaluation", 5).map((n) => n.id)).toContain("n_eval");
    expect(g.searchFts("registration", 5).map((n) => n.id)).toContain("n_register");
    expect(g.searchFts("registering", 5).map((n) => n.id)).toContain("n_register");
    // unrelated words stay unrelated
    expect(g.searchFts("cat", 5)).toEqual([]);
    expect(g.searchFts("evaluate", 5).map((n) => n.id)).not.toContain("n_cat");
    g.close();
  });

  it("applies the same morphology to file bodies (both directions)", () => {
    const g = GraphStore.open(":memory:");
    g.setFileTokens("a/engine.go", "eval eval eval the statement");
    g.setFileTokens("b/registry.ts", "registration handled here");
    expect(g.fileRelevance("evaluate").get("a/engine.go")).toBe(1);
    expect(g.fileRelevance("register").get("b/registry.ts")).toBe(1);
    expect(g.fileRelevance("cat")).toEqual(new Map());
    g.close();
  });

  it("caps a file at 4096 body tokens deterministically, in file order", () => {
    const g = GraphStore.open(":memory:");
    // Token 4097 onward is past the cap: "zzzlate" must be invisible.
    const body = [...Array(4096).fill("filler"), "zzzlate"].join(" ");
    g.setFileTokens("big.ts", body);
    expect(g.fileRelevance("filler").get("big.ts")).toBe(1);
    expect(g.fileRelevance("zzzlate")).toEqual(new Map());

    // Same bytes twice ⇒ same prior (no accumulation, no drift).
    g.setFileTokens("big.ts", body);
    expect(g.fileRelevance("filler").get("big.ts")).toBe(1);
    g.close();
  });

  it("replaces on re-index and deletes the row for an empty body", () => {
    const g = GraphStore.open(":memory:");
    g.setFileTokens("a.ts", "epoll reactor");
    expect(g.fileRelevance("epoll").get("a.ts")).toBe(1);
    g.setFileTokens("a.ts", "socket accept"); // body rewritten: old tokens gone
    expect(g.fileRelevance("epoll")).toEqual(new Map());
    expect(g.fileRelevance("socket").get("a.ts")).toBe(1);
    g.setFileTokens("a.ts", ""); // no usable tokens ⇒ row dropped
    expect(g.fileRelevance("socket")).toEqual(new Map());
    g.setFileTokens("b.ts", "a b c"); // all 1-char ⇒ basicTokens filters them out
    expect(g.fileRelevance("a")).toEqual(new Map());
    g.close();
  });

  it("returns an empty map when the DB predates files_fts, and never writes read-only", () => {
    const dir = mkdtempSync(join(tmpdir(), "rinnegan-files-fts-"));
    const dbPath = join(dir, "graph.db");
    new Database(dbPath).close(); // bare SQLite file: no schema, no files_fts

    const ro = GraphStore.open(dbPath, { readonly: true });
    expect(ro.fileRelevance("epoll")).toEqual(new Map()); // missing table is a no-op, not a throw
    expect(() => ro.setFileTokens("a.ts", "epoll")).not.toThrow(); // silently skipped
    ro.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("migrates a pre-path files_fts by recreating it and stamping files for backfill", () => {
    const dir = mkdtempSync(join(tmpdir(), "rinnegan-fts-mig-"));
    const dbPath = join(dir, "graph.db");
    // A database written by the previous version: old files_fts (no path_tokens)
    // and a `files` row that has no fts_version stamp.
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE files (path TEXT PRIMARY KEY, hash TEXT NOT NULL, mtime_ms REAL NOT NULL,
                          node_ids TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'library',
                          analyzer_version INTEGER NOT NULL DEFAULT 0);
      CREATE VIRTUAL TABLE files_fts USING fts5(file UNINDEXED, tokens);
      INSERT INTO files (path, hash, mtime_ms, node_ids, role, analyzer_version)
        VALUES ('a.ts', 'h', 1, '[]', 'library', 1);
      INSERT INTO files_fts (file, tokens) VALUES ('a.ts', 'legacy body tokens');
    `);
    legacy.close();

    const g = GraphStore.open(dbPath);
    // Rewriting rows is required: the old token row is gone and the file is
    // stamped so `index` knows to backfill it exactly once.
    expect(g.fileRelevance("legacy")).toEqual(new Map());
    expect(g.getFileMeta("a.ts")!.ftsVersion).toBe(0);
    // The new writer stores path tokens, so the very next write is path-aware.
    g.setFileTokens("promql/engine.go", "eval");
    expect(g.fileRelevance("promql").get("promql/engine.go")).toBe(1);
    g.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("GraphStore semantic cache", () => {
  it("stores one payload per corpus key and never serves a different key", () => {
    const g = GraphStore.open(":memory:");
    expect(g.readSemanticCache("k1")).toBeUndefined(); // empty table
    expect(g.writeSemanticCache("k1", Buffer.from("payload"))).toBe(true);
    expect(g.readSemanticCache("k1")?.toString()).toBe("payload");
    expect(g.readSemanticCache("k2")).toBeUndefined(); // stale key ≠ whatever is stored
    g.deleteSemanticCache();
    expect(g.readSemanticCache("k1")).toBeUndefined();
    g.close();
  });

  it("tolerates a DB that predates the cache table and refuses to write read-only", () => {
    const dir = mkdtempSync(join(tmpdir(), "rinnegan-store-"));
    const dbPath = join(dir, "graph.db");
    new Database(dbPath).close(); // bare SQLite file: no schema at all, let alone semantic_cache

    const ro = GraphStore.open(dbPath, { readonly: true });
    expect(ro.isReadOnly()).toBe(true);
    expect(ro.readSemanticCache("k")).toBeUndefined(); // missing table is a miss, not a throw
    expect(ro.writeSemanticCache("k", Buffer.from("payload"))).toBe(false);
    ro.close();

    const rw = GraphStore.open(dbPath);
    expect(rw.readSemanticCache("k")).toBeUndefined(); // nothing was written
    rw.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
