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

  it("excludes test files from the slice unless task has test intent", async () => {
    const root = fixture({
      "src/pay.ts": "export function charge() {}",
      "src/pay.test.ts": "export function charge() {}",
    });
    const vx = Rinnegan.open(root, { dbPath: ":memory:" });
    await vx.indexAll();
    const slice = vx.understand("charge payment");
    expect(slice.text).toContain("src/pay.ts");
    expect(slice.text).not.toContain("src/pay.test.ts");
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

describe("covered-by (test linkage in DETAIL)", () => {
  afterAll(() => {
    for (const d of fixtureDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("a def called from a test file gets a covered-by line naming it; an uncalled def gets (none)", async () => {
    const root = fixture({
      "src/pay.ts": [
        "export function charge() { return 1; }",
        "export function refund() { return 2; }",
      ].join("\n"),
      "src/pay.test.ts": ["import { charge } from \"./pay\";", "charge();"].join("\n"),
    });
    const vx = Rinnegan.open(root, { dbPath: ":memory:" });
    await vx.indexAll();

    const chargeSlice = vx.understand("charge payment", { tokenBudget: 4000 });
    expect(chargeSlice.text).toContain("covered-by: src/pay.test.ts");

    const refundSlice = vx.understand("refund payment", { tokenBudget: 4000 });
    expect(refundSlice.text).toContain("covered-by: (none)");
    vx.close();
  });
});

describe("understand --scope", () => {
  afterAll(() => {
    for (const d of fixtureDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  // Two domains (auth/, billing/) with no cross-file edges, so computeDomains
  // keeps them separate. Both define a "gizmo*" symbol — the shared term that
  // the FTS fallback matches in *both* domains when unscoped — but every other
  // identifier (loginFlow/chargeFlow, param names u/c) is a distinct word, so
  // no incidental camelCase subtoken links the two domains together.
  const SCOPE_FILES = {
    "auth/login.ts": [
      "export function loginFlow(u: string) {",
      "  return gizmoCheck(u);",
      "}",
      "function gizmoCheck(u: string) {",
      "  return u.length > 0;",
      "}",
    ].join("\n"),
    "billing/charge.ts": [
      "export function chargeFlow(c: string) {",
      "  return gizmoVerify(c);",
      "}",
      "function gizmoVerify(c: string) {",
      "  return c.length > 0;",
      "}",
    ].join("\n"),
  };

  it("restricts the slice to the scoped domain's files", async () => {
    const root = fixture(SCOPE_FILES);
    const vx = Rinnegan.open(root, { dbPath: ":memory:" });
    await vx.indexAll();
    const res = vx.understand("gizmo", { scope: "auth" });
    expect(res.text).toContain("auth/login.ts");
    expect(res.text).not.toContain("billing/charge.ts");
    vx.close();
  });

  it("throws for an unknown scope, listing available domains", async () => {
    const root = fixture(SCOPE_FILES);
    const vx = Rinnegan.open(root, { dbPath: ":memory:" });
    await vx.indexAll();
    expect(() => vx.understand("gizmo", { scope: "nope" })).toThrow(
      "unknown domain 'nope' — available: auth, billing",
    );
    vx.close();
  });
});

describe("retrieval accuracy guards (from blind A/B judging)", () => {
  it("keeps test-harness bytes out of a production slice unless the task asks about tests", async () => {
    const root = fixture({
      "auth.ts": [
        "export function login(username: string) {",
        "  return authenticateUser(username);",
        "}",
        "function authenticateUser(u: string) {",
        "  return u.length > 0;",
        "}",
      ].join("\n"),
      // Lexically louder than production: every query word lives here, and
      // pre-guard this captured 100% of the slice for the VNC query class.
      "tests/auth.console.test.ts": [
        "import { login } from '../auth.js';",
        "function loginAuthenticationConsoleFlowHarness() {",
        "  const consoleFlow = login('u');",
        "  return consoleFlow;",
        "}",
      ].join("\n"),
    });
    const vx = Rinnegan.open(root, { dbPath: ":memory:" });
    await vx.indexAll();
    // Build store/semantic directly (the pattern used above) — Rinnegan keeps
    // both private and builds semantic lazily.
    const store = GraphStore.open(":memory:");
    await new Indexer(store).indexAll(root);
    const semantic = SemanticEngine.build(store);
    const task = "login authentication console flow";

    const prod = understand(store, semantic, task, { root, tokenBudget: 4000 });
    expect(prod.text).toContain("auth.ts");
    // The harness's SOURCE must not appear; a covered-by pointer is fine.
    expect(prod.text).not.toContain("tests/auth.console.test.ts:");
    expect(prod.text).not.toContain("loginAuthenticationConsoleFlowHarness");

    const withIntent = understand(store, semantic, "login authentication test", { root, tokenBudget: 4000 });
    expect(withIntent.text).toContain("auth.console.test.ts");
    vx.close();
  });

  it("boosts callers of top-ranked seeds (controller → service chain)", async () => {    const root = fixture({
      "deploy.ts": "export function deployInstance() { return 1; }\n",
      "controller.ts": [
        "import { deployInstance } from './deploy.js';",
        "export function createInstance() { return deployInstance(); }",
      ].join("\n"),
      "unrelated.ts": "export function wireMoney() { return 2; }\n",
    });
    const store = GraphStore.open(":memory:");
    await new Indexer(store).indexAll(root);
    const byName = (name: string): string => {
      const n = store.allNodes().find((n) => n.qualifiedName === name && n.kind === "function");
      if (!n) throw new Error(`fixture symbol not indexed: ${name}`);
      return n.id;
    };
    const deployId = byName("deployInstance");
    const createId = byName("createInstance");
    const wireId = byName("wireMoney");
    // wireMoney is deliberately MORE lexically relevant; only the caller-chain
    // bonus (createInstance → deployInstance, deployInstance is the seed)
    // lets the controller outrank it.
    const relevance = new Map([[deployId, 1], [createId, 0.2], [wireId, 0.3]]);
    const ranked = rankNodes(store, new Set([deployId, createId, wireId]), relevance, { seedIds: new Set([deployId]) });
    expect(ranked[0].node.qualifiedName).toBe("deployInstance");
    expect(ranked[1].node.qualifiedName).toBe("createInstance");
    expect(ranked[1].score).toBeGreaterThan(ranked[2].score);
    store.close();
  });

  it("substring fallback seeds symbols whose token CONTAINS a query token (vnc → noVncGuard)", async () => {
    const root = fixture({
      "auth.ts": "export function noVncGuard() { return 1; }\n",
    });
    const store = GraphStore.open(":memory:");
    await new Indexer(store).indexAll(root);
    const semantic = SemanticEngine.build(store);
    // No whole-token match exists for "vnc" — only the substring pass reaches it.
    const whole = semantic.seed("vnc guard", 8).filter((s) => {
      const n = store.getNode(s.id);
      return n?.qualifiedName === "noVncGuard";
    });
    expect(whole.length).toBeGreaterThan(0);
    store.close();
  });
});

describe("file-body BM25 prior (files_fts)", () => {
  afterAll(() => {
    for (const d of fixtureDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  // Two symbols with the SAME name and the SAME relevance — only the file BODY
  // separates them. Pre-prior, `handle` in sched/queue.rs is indistinguishable
  // from `handle` in io/driver.rs, exactly the capture the A/B run showed.
  const FILES = {
    "runtime/io/driver.rs": [
      "// epoll event loop drives every io resource",
      "pub fn handle(resource: u32) -> u32 { resource }",
    ].join("\n"),
    "runtime/sched/queue.rs": [
      "// scheduling queue bookkeeping",
      "pub fn handle(resource: u32) -> u32 { resource }",
    ].join("\n"),
  };

  it("ranks the symbol whose file body matches the task higher at equal relevance", async () => {
    const root = fixture(FILES);
    const store = GraphStore.open(":memory:");
    await new Indexer(store).indexAll(root);

    const driver = store.allNodes().find((n) => n.filePath === "runtime/io/driver.rs" && n.kind === "function")!;
    const queue = store.allNodes().find((n) => n.filePath === "runtime/sched/queue.rs" && n.kind === "function")!;
    const ids = new Set([driver.id, queue.id]);
    const relevance = new Map([[driver.id, 0.5], [queue.id, 0.5]]); // equal — isolates the file prior

    const prior = store.fileRelevance("how does the runtime drive io resources with epoll");
    expect(prior.get("runtime/io/driver.rs")).toBe(1);
    expect(prior.get("runtime/sched/queue.rs") ?? 0).toBe(0);

    const withPrior = rankNodes(store, ids, relevance, { fileRelevance: prior });
    const byId = (r: typeof withPrior) => new Map(r.map((x) => [x.node.id, x.score]));
    expect(byId(withPrior).get(driver.id)!).toBeGreaterThan(byId(withPrior).get(queue.id)!);
    // (1 + 2·1) vs (1 + 2·0): the top file's symbol triples, the unmatched one is untouched.
    expect(byId(withPrior).get(driver.id)! / byId(withPrior).get(queue.id)!).toBeCloseTo(3, 10);

    // No prior supplied ⇒ old math, identical scores and input order preserved.
    const without = rankNodes(store, ids, relevance);
    const noPrior = new Map(without.map((x) => [x.node.id, x.score]));
    expect(noPrior.get(driver.id)!).toBe(noPrior.get(queue.id)!);
    expect(without.map((r) => r.node.id)).toEqual([...ids]);
    store.close();
  });

  it("feeds the prior into understand() so the matching file's DETAIL leads", async () => {
    const root = fixture(FILES);
    const store = GraphStore.open(":memory:");
    await new Indexer(store).indexAll(root);
    const semantic = SemanticEngine.build(store);
    const res = understand(store, semantic, "epoll event loop io resource", { root, tokenBudget: 4000 });
    expect(res.facts[0]?.body ?? "").toContain("runtime/io/driver.rs");
    store.close();
  });

  it("seats a prior-top file's symbols in the RANKING pool without making them anchors", async () => {
    // Rust emits `calls` edges only (no cross-file references), so a file whose
    // SYMBOL NAMES say nothing about the task is unreachable from any anchor.
    // Only the body prior can surface it — and it must do so without seeding.
    const root = fixture({
      "runtime/api.rs": ["// entry surface", "pub fn start() -> u32 { 1 }"].join("\n"),
      "runtime/io/driver.rs": [
        "// the epoll driver turns io readiness into events",
        "pub fn turn() -> u32 { 2 }",
      ].join("\n"),
    });
    const store = GraphStore.open(":memory:");
    await new Indexer(store).indexAll(root);
    const semantic = SemanticEngine.build(store);
    const res = understand(store, semantic, "start epoll io readiness", { root, tokenBudget: 4000 });

    expect(store.fileRelevance("start epoll io readiness").get("runtime/io/driver.rs")).toBe(1);
    const anchorFiles = res.anchors.map((id) => store.getNode(id)?.filePath);
    expect(anchorFiles).toContain("runtime/api.rs");
    expect(anchorFiles).not.toContain("runtime/io/driver.rs"); // prior never seeds
    expect(res.text).toContain("runtime/io/driver.rs:2"); // …but it does re-seat ranking
    store.close();
  });
});
