import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { GraphStore } from "../graph/store.js";
import { Indexer } from "./indexer.js";

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

describe("Indexer", () => {
  it("indexes files into the graph", async () => {
    const store = GraphStore.open(":memory:");
    const stats = await new Indexer(store).indexAll(root);
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
    await new Indexer(s1).indexAll(root);
    s1.close();

    const s2 = GraphStore.open(dbPath);
    const stats = await new Indexer(s2).indexAll(root);
    expect(stats.parsed).toBe(0);
    expect(stats.skipped).toBe(stats.scanned);
    s2.close();
  });

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
    store.close();
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
    store.close();
  });

  it("F2: reindexing a file whose export is unchanged preserves inbound resolved cross-file call edges", async () => {
    const root = fixture({
      "a.ts": "export function fn() { return 1 }",
      "b.ts": `import { fn } from "./a";\nexport function useIt() { return fn() }`,
    });
    const store = GraphStore.open(":memory:");
    const ix = new Indexer(store);
    await ix.indexAll(root);

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
    await ix.indexAll(root);

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
    await ix.indexAll(root);

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
    await ix.indexAll(root);

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
    await ix.indexAll(root);

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
    store.close();
  });
});
