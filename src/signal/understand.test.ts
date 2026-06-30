import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../graph/store.js";
import { Indexer } from "../index/indexer.js";
import { SemanticEngine } from "../semantic/engine.js";
import { understand } from "./understand.js";
import { minifyBlock } from "./render.js";

describe("minifyBlock", () => {
  it("dedents, elides blank lines, keeps line numbers", () => {
    const lines = ["    function f() {", "", "      return authenticate();", "    }"];
    const out = minifyBlock(lines, 10);
    const outLines = out.split("\n");
    expect(out).not.toMatch(/\n\s*\n/); // no blank line retained
    // 3 emitted lines (line 11 blank elided), numbered 10, 12, 13 — the gap signals the blank
    expect(outLines).toHaveLength(3);
    expect(outLines[0]).toMatch(/^\s*10\s+function f\(\) \{$/); // common indent stripped
    expect(outLines[1]).toMatch(/^\s*12\s+return authenticate\(\);$/);
    expect(outLines[2]).toMatch(/^\s*13\s+\}$/);
  });
});

describe("understand", () => {
  let root: string;
  let store: GraphStore;
  let semantic: SemanticEngine;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "rinnegan-und-"));
    writeFileSync(
      join(root, "auth.ts"),
      [
        "export function login(username: string, password: string) {",
        "  const ok = validateCredentials(username, password);",
        "  return ok ? createSession(username) : null;",
        "}",
        "function validateCredentials(u: string, p: string) {",
        "  return u.length > 0 && p.length > 0;",
        "}",
        "function createSession(u: string) {",
        "  return { user: u, token: u + '-token' };",
        "}",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "math.ts"),
      "export function addNumbers(a: number, b: number){ return a + b }",
    );
    store = GraphStore.open(":memory:");
    await new Indexer(store).indexAll(root);
    semantic = SemanticEngine.build(store);
  });
  afterAll(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("returns a slice containing the relevant symbol with file:line", () => {
    const res = understand(store, semantic, "user login authentication", { root, tokenBudget: 4000 });
    expect(res.text).toContain("auth.ts:");
    expect(res.text.toLowerCase()).toContain("login");
    expect(res.anchors.length).toBeGreaterThan(0);
  });

  it("stays within the token budget", () => {
    const res = understand(store, semantic, "login", { root, tokenBudget: 1500 });
    expect(res.tokensEstimate).toBeLessThanOrEqual(1500);
  });

  it("every fact carries a provenance tag", () => {
    const res = understand(store, semantic, "login", { root });
    for (const f of res.facts) {
      expect(f.body).toMatch(/\[(ast_exact|ast_inferred|heuristic|lexical|latent|unresolved)\]/);
    }
  });
});

describe("harmonic multi-resolution", () => {
  let hroot: string;
  let hstore: GraphStore;
  let hsem: SemanticEngine;
  beforeAll(async () => {
    hroot = mkdtempSync(join(tmpdir(), "rinnegan-harm-"));
    writeFileSync(join(hroot, "auth.ts"), [
      "export function login(username: string) {",
      "  const ok = validateCredentials(username);",
      "  return ok ? createSession(username) : null;",
      "}",
      "function validateCredentials(u: string){ return u.length > 0 }",
      "function createSession(u: string){ return { user: u } }",
    ].join("\n"));
    hstore = GraphStore.open(":memory:");
    await new Indexer(hstore).indexAll(hroot);
    hsem = SemanticEngine.build(hstore);
  });
  afterAll(() => { hstore.close(); rmSync(hroot, { recursive: true, force: true }); });

  it("emits MAP, SIGNATURES and DETAIL tiers within budget", () => {
    const r = understand(hstore, hsem, "user login", { root: hroot, tokenBudget: 2000 });
    expect(r.text).toContain("# MAP");
    expect(r.text).toContain("# SIGNATURES");
    expect(r.text).toContain("# DETAIL");
    expect(r.text.toLowerCase()).toContain("login");
    expect(r.tokensEstimate).toBeLessThanOrEqual(2000);
  });

  it("flat mode omits the tiers (back-compat)", () => {
    const r = understand(hstore, hsem, "user login", { root: hroot, resolution: "flat" });
    expect(r.text).not.toContain("# MAP");
  });
});
