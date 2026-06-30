import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../graph/store.js";
import { Indexer } from "./indexer.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rinnegan-idx-"));
  writeFileSync(join(root, "auth.ts"), `export function login(user: string){ return validate(user) } function validate(u: string){ return u.length > 0 }`);
  writeFileSync(join(root, "main.ts"), `function run(){ const r = 1; return r }`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

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
});
