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
});
