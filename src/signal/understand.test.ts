import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { GraphStore } from "../graph/store.js";
import { Indexer } from "../index/indexer.js";
import { SemanticEngine } from "../semantic/engine.js";
import { understand } from "./understand.js";
import { minifyBlock } from "./render.js";
import { rankNodes } from "./rank.js";
import { Rinnegan } from "../index.js";

const fixtureDirs: string[] = [];

/** Fresh temp dir seeded with the given relative-path → content files. */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rinnegan-und-fx-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  fixtureDirs.push(dir);
  return dir;
}

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

describe("role-aware ranking", () => {
  afterAll(() => {
    for (const d of fixtureDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

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
    vx.close();
  });

  // The text-level assertion above passes even without role weighting: the two
  // "charge" symbols get slightly different relevance scores from the semantic
  // engine as an incidental side effect, not from role logic. Pin the real
  // behavior directly on rankNodes with equal relevance so this test actually
  // fails without the ROLE_WEIGHT multiplier (and passes once it's applied).
  it("rankNodes multiplies ROLE_WEIGHT into score, with a test-intent escape hatch", async () => {
    const root = fixture({
      "src/pay.ts": "export function charge() {}",
      "src/pay.test.ts": "export function charge() {}",
    });
    const store = GraphStore.open(":memory:");
    await new Indexer(store).indexAll(root);
    const ids = new Set(store.allNodes().filter((n) => n.kind === "function").map((n) => n.id));
    const relevance = new Map([...ids].map((id) => [id, 0.5])); // equal relevance — isolates role weighting

    const ranked = rankNodes(store, ids, relevance, { roles: store.roleByFile() });
    const byPath = (r: typeof ranked) => new Map(r.map((x) => [x.node.filePath, x.score]));
    const scores = byPath(ranked);
    expect(scores.get("src/pay.ts")!).toBeGreaterThan(scores.get("src/pay.test.ts")!);

    const rankedIntent = rankNodes(store, ids, relevance, { roles: store.roleByFile(), testIntent: true });
    const scoresIntent = byPath(rankedIntent);
    expect(scoresIntent.get("src/pay.test.ts")!).toBe(scoresIntent.get("src/pay.ts")!); // test escapes to roleW 1.0, ties library
    store.close();
  });
});
