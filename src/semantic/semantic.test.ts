import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { truncatedSvd, denseToSparse } from "./svd.js";
import { LsaIndex } from "./lsa.js";
import { Bm25Index } from "./bm25.js";
import { rrfFuse } from "./fuse.js";
import { deserializeModel, serializeModel } from "./cache.js";
import { SemanticEngine, semanticCacheKey } from "./engine.js";
import { GraphStore } from "../graph/store.js";

describe("truncatedSvd", () => {
  it("is deterministic and sign-canonical", () => {
    const m = [
      [1, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
      [0, 0, 1],
    ];
    const sparse = denseToSparse(m);
    const a = truncatedSvd(sparse, 2, { seed: 42 });
    const b = truncatedSvd(sparse, 2, { seed: 42 });
    expect(a.s).toEqual(b.s);
    expect(a.u).toEqual(b.u);
    expect(a.v).toEqual(b.v);
    expect(a.s.length).toBe(2);
    // largest singular value first
    expect(a.s[0]).toBeGreaterThanOrEqual(a.s[1]);
  });
});

describe("LsaIndex", () => {
  const docs = [
    { id: "auth", text: "handleUserSession authenticate login credential validatePassword" },
    { id: "math", text: "computeSum addNumbers multiplyMatrix factorial" },
    { id: "render", text: "drawCanvas paintPixels renderFrame displayImage" },
  ];

  it("ranks the auth doc highest for a login-flow query (semantic, no model)", () => {
    const idx = LsaIndex.build(docs);
    const res = idx.query("user login flow", 3);
    expect(res.length).toBeGreaterThan(0);
    expect(res[0].id).toBe("auth");
  });

  it("is deterministic across builds", () => {
    const a = LsaIndex.build(docs).query("login", 3);
    const b = LsaIndex.build(docs).query("login", 3);
    expect(a).toEqual(b);
  });
});

describe("Bm25Index + rrfFuse", () => {
  const docs = [
    { id: "auth", text: "authenticate login session" },
    { id: "db", text: "database query connection" },
  ];

  it("bm25 finds keyword match", () => {
    const idx = new Bm25Index(docs);
    expect(idx.search("login", 2)[0].id).toBe("auth");
  });

  it("rrf fuses two lists deterministically", () => {
    const fused = rrfFuse([
      [{ id: "auth", score: 0.9 }, { id: "db", score: 0.1 }],
      [{ id: "auth", score: 0.5 }],
    ]);
    expect(fused[0].id).toBe("auth");
  });
});

import { docTokens, expandSynonyms } from "./tokenize.js";
describe("tokenize prototype safety", () => {
  it("handles prototype-named tokens without crashing (regression)", () => {
    expect(() => expandSynonyms(["constructor", "toString", "hasOwnProperty"])).not.toThrow();
    expect(docTokens("constructor valueOf")).toContain("constructor");
  });
});

describe("LSA state round-trip", () => {
  const docs = [
    { id: "auth", text: "handleUserSession authenticate login credential validatePassword" },
    { id: "math", text: "computeSum addNumbers multiplyMatrix factorial" },
    { id: "render", text: "drawCanvas paintPixels renderFrame displayImage" },
  ];

  it("fromState(toState()) queries bit-identically to the built index", () => {
    const built = LsaIndex.build(docs);
    const reloaded = LsaIndex.fromState(built.toState());
    expect(reloaded.query("user login flow", 3)).toEqual(built.query("user login flow", 3));
    expect(reloaded.query("canvas image", 3)).toEqual(built.query("canvas image", 3));
  });
});

describe("semantic cache payload", () => {
  const docs = [
    { id: "auth", text: "authenticate login session credential" },
    { id: "bill", text: "invoice total charge statement" },
    { id: "draw", text: "canvas paint frame buffer" },
  ];

  function payload(): Buffer {
    const lsa = LsaIndex.build(docs);
    const bm25 = new Bm25Index(docs);
    return serializeModel({ lsa: lsa.toState(), bm25: bm25.toState() });
  }

  it("round-trips both halves exactly", () => {
    const state = deserializeModel(payload());
    expect(state).toBeTruthy();
    expect(state!.lsa.ids).toEqual(["auth", "bill", "draw"]);
    expect(state!.bm25.ids).toEqual(state!.lsa.ids);
    expect(state!.lsa.vocab).toEqual(LsaIndex.build(docs).toState().vocab);
  });

  it("rejects an unknown format version and a truncated payload (cache miss, not a wrong model)", () => {
    const buf = payload();
    const bumped = Buffer.from(buf);
    bumped.writeUInt32LE(999, 8);
    expect(deserializeModel(bumped)).toBeUndefined();
    expect(deserializeModel(buf.subarray(0, buf.length - 4))).toBeUndefined();
    expect(deserializeModel(Buffer.from("not a cache payload"))).toBeUndefined();
  });
});


describe("SemanticEngine persistence", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function tempDb(): string {
    const dir = mkdtempSync(join(tmpdir(), "rinnegan-sem-"));
    dirs.push(dir);
    return join(dir, "graph.db");
  }

  /** A tiny corpus with distinct vocabularies per symbol, plus file metadata so the fingerprint means something. */
  function seedCorpus(g: GraphStore): void {
    const put = (id: string, qn: string, sig: string, doc: string, file: string) =>
      g.insertNode({
        id, kind: "function", qualifiedName: qn, filePath: file, language: "ts",
        startLine: 1, endLine: 4, signature: sig, docstring: doc,
      });
    put("n_auth", "authenticateUser", "authenticateUser(token: string): Session",
      "Validates the login credential and opens an authenticated session.", "auth.ts");
    put("n_bill", "computeInvoiceTotal", "computeInvoiceTotal(lines: Line[]): number",
      "Sums invoice line amounts for the monthly billing statement.", "billing.ts");
    put("n_draw", "renderCanvasFrame", "renderCanvasFrame(ctx: Context): void",
      "Paints the frame buffer onto the canvas image surface.", "render.ts");
    g.setFileMeta("auth.ts", { hash: "h1", mtimeMs: 1, nodeIds: ["n_auth"], role: "library", analyzerVersion: 1 });
    g.setFileMeta("billing.ts", { hash: "h2", mtimeMs: 1, nodeIds: ["n_bill"], role: "library", analyzerVersion: 1 });
    g.setFileMeta("render.ts", { hash: "h3", mtimeMs: 1, nodeIds: ["n_draw"], role: "library", analyzerVersion: 1 });
  }

  function expectSameScored(a: { id: string; score: number }[], b: { id: string; score: number }[]): void {
    expect(a.map((s) => s.id)).toEqual(b.map((s) => s.id));
    a.forEach((s, i) => expect(Math.abs(s.score - b[i].score)).toBeLessThan(1e-6));
  }

  it("round-trips through the graph DB: a rebuilt model and a loaded one agree exactly", () => {
    const db = tempDb();
    let g = GraphStore.open(db);
    seedCorpus(g);

    const built = SemanticEngine.load(g); // miss → build + save
    expect(g.readSemanticCache(semanticCacheKey(g))?.length ?? 0).toBeGreaterThan(0);
    const seedsBuilt = built.seed("user login session", 5);
    const relBuilt = built.relevance("billing invoice total");
    expect(seedsBuilt.length).toBeGreaterThan(0); // guard: the fixture actually ranks something
    g.close();

    g = GraphStore.open(db);
    const loaded = SemanticEngine.load(g); // hit → no SVD, no tokenization
    expectSameScored(loaded.seed("user login session", 5), seedsBuilt);

    const relLoaded = loaded.relevance("billing invoice total");
    expect([...relLoaded.keys()]).toEqual([...relBuilt.keys()]);
    for (const [id, score] of relBuilt) expect(Math.abs(relLoaded.get(id)! - score)).toBeLessThan(1e-6);
    g.close();
  });

  it("invalidates the cache when the graph changes (mutated index must never be served)", () => {
    const db = tempDb();
    const g = GraphStore.open(db);
    seedCorpus(g);
    SemanticEngine.load(g);
    const savedKey = semanticCacheKey(g);

    // A mutation that does not come from a file re-index: node count changes, so the key must too.
    g.insertNode({
      id: "n_refund", kind: "function", qualifiedName: "refundPaymentWatcher",
      filePath: "refund.ts", language: "ts", startLine: 1, endLine: 3,
      signature: "refundPaymentWatcher(paymentId: string): void",
      docstring: "Watches refund payment events and reconciles the ledger.",
    });
    expect(semanticCacheKey(g)).not.toEqual(savedKey);
    expect(g.readSemanticCache(semanticCacheKey(g))).toBeUndefined(); // the old row cannot be reached

    const rebuilt = SemanticEngine.load(g);
    expect(rebuilt.seed("refundPaymentWatcher", 3).map((s) => s.id)).toContain("n_refund");
    // …and the fresh model was persisted under the new key.
    expect(g.readSemanticCache(semanticCacheKey(g))).toBeInstanceOf(Buffer);
    g.close();
  });

  it("loads on a read-only DB without throwing and writes no cache row", () => {
    const db = tempDb();
    const w = GraphStore.open(db);
    seedCorpus(w);
    w.close(); // deliberately no cache row: the read-only load has to build

    const g = GraphStore.open(db, { readonly: true });
    expect(g.isReadOnly()).toBe(true);
    const engine = SemanticEngine.load(g);
    expect(engine.seed("login session credential", 3).length).toBeGreaterThan(0);
    expect(engine.relevance("canvas frame").size).toBeGreaterThan(0);
    expect(g.readSemanticCache(semanticCacheKey(g))).toBeUndefined();
    g.close();
  });
});
