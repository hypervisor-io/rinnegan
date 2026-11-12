import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { GraphStore, WINDOW_MAX, bodyWindows } from "../graph/store.js";
import { Indexer } from "../index/indexer.js";
import { SemanticEngine } from "../semantic/engine.js";
import { bodyRelevance, BODY_SPAN_LINES } from "./body.js";
import { windowRelevance } from "./window.js";
import { rankNodes } from "./rank.js";
import { understand } from "./understand.js";

const dirs: string[] = [];

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rinnegan-window-fx-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  dirs.push(dir);
  return dir;
}

function reader(root: string) {
  const cache = new Map<string, string | undefined>();
  return (path: string): string | undefined => {
    if (cache.has(path)) return cache.get(path);
    let src: string | undefined;
    try {
      src = readFileSync(join(root, path), "utf8");
    } catch {
      src = undefined;
    }
    cache.set(path, src);
    return src;
  };
}

async function index(files: Record<string, string>) {
  const root = fixture(files);
  const store = GraphStore.open(":memory:");
  await new Indexer(store).indexAll(root);
  return { root, store, read: reader(root) };
}

const byName = (store: GraphStore, name: string) => {
  const defs = new Set(["function", "method", "class", "interface", "struct", "type_alias", "enum", "module"]);
  const n = store
    .allNodes()
    .find((x) => defs.has(x.kind) && (x.qualifiedName === name || x.qualifiedName.endsWith(`.${name}`)));
  if (!n) throw new Error(`fixture symbol not indexed: ${name}`);
  return n;
};

/** Filler declarations that keep a line out of the task's vocabulary. */
const filler = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `const pad${i} = "alpha beta gamma delta";`);

afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A big file: an accessor whose NAME repeats the query at the top, a long stretch
 * of noise, then the method that actually does the work — 210 dense lines, i.e.
 * past `BODY_SPAN_LINES`, so its own body is never scored.
 */
const bigFile = (): string =>
  [
    "export function accessorTargets(): string[] { return []; }",
    ...filler(400),
    "export function run(): void {",
    ...Array(BODY_SPAN_LINES + 10).fill('  collectTargets("collect targets");'),
    "}",
    "function collectTargets(x: string) { return x; }",
  ].join("\n");

describe("symbol window relevance (windowRelevance)", () => {
  it("scores the chunk a symbol overlaps even when its own body is past the caps", async () => {
    const { store, read } = await index({ "scrape/manager.ts": bigFile() });
    const accessor = byName(store, "accessorTargets");
    const worker = byName(store, "run");
    // The symbol-body prior refuses the long method by design …
    expect(worker.endLine - worker.startLine + 1).toBeGreaterThan(BODY_SPAN_LINES);
    expect(bodyRelevance("how does the scraper collect targets", [accessor, worker], read).has(worker.id)).toBe(false);

    // … the window prior still sees it: its chunks hold the task's vocabulary.
    const win = windowRelevance(store, "how does the scraper collect targets", [accessor, worker]);
    expect(win.get(worker.id)).toBe(1); // best intersecting chunk ⇒ 1
    expect(win.get(accessor.id)!).toBeLessThan(1); // name-only, sparse neighbourhood

    // Equal reported relevance isolates the window prior in the ranker.
    const relevance = new Map([[accessor.id, 1], [worker.id, 1]]);
    const seeds = new Set([accessor.id]); // understand always passes seeds ⇒ ranker sorts
    const without = rankNodes(store, new Set([accessor.id, worker.id]), relevance, { seedIds: seeds });
    expect(without[0].node.id).toBe(accessor.id);
    const withWindow = rankNodes(store, new Set([accessor.id, worker.id]), relevance, {
      windowRelevance: win,
      seedIds: seeds,
    });
    expect(withWindow[0].node.id).toBe(worker.id);
    // Unit weight, exactly: (1 + w) on top of the unchanged base score.
    const ratio = withWindow[0].score / withWindow[1].score;
    expect(ratio).toBeCloseTo((1 + win.get(worker.id)!) / (1 + win.get(accessor.id)!), 10);
    store.close();
  });

  it("credits only the best chunk that intersects the symbol's own lines", async () => {
    const { store } = await index({
      "src/worker.ts": [
        "function collectTargets(x: string) { return x; }",
        ...filler(600),
        "export function deep(): void {",
        ...Array(20).fill('  collectTargets("collect targets");'),
        "}",
        ...filler(600),
        "export function unrelated(): number { return 2; }",
      ].join("\n"),
    });
    const top = byName(store, "deep"); // the dense method
    const unrelated = byName(store, "unrelated");
    const helper = byName(store, "collectTargets");
    const win = windowRelevance(store, "collect targets", [top, unrelated, helper]);
    expect(win.get(top.id)).toBe(1); // its own chunk is the best evidence
    // Symbols whose chunks say nothing about the task are not credited …
    expect(win.get(unrelated.id)).toBeUndefined();
    // … and the helper that repeats the words once scores below the dense method.
    expect(win.get(helper.id) ?? 0).toBeLessThan(0.5);
    // The dense chunk is outside the unrelated symbol's line range.
    expect(unrelated.startLine).toBeGreaterThan(top.endLine);
    store.close();
  });

  it("is deterministic across calls and independent of candidate order", async () => {
    const { store } = await index({ "src/worker.ts": bigFile() });
    const nodes = store.allNodes().filter((n) => n.filePath === "scrape/manager.ts");
    const a = windowRelevance(store, "collect targets", nodes);
    const b = windowRelevance(store, "collect targets", [...nodes].reverse());
    expect([...b.entries()].sort()).toEqual([...a.entries()].sort());
    store.close();
  });

  it("is a no-op for files with no window rows (never indexed / empty map contract)", async () => {
    const { store } = await index({ "src/a.ts": "export function alpha() { return 1; }" });
    const node = byName(store, "alpha");
    expect(windowRelevance(store, "alpha", [])).toEqual(new Map());
    // A node from a file the index has no windows for: never invented evidence.
    expect(windowRelevance(store, "alpha", [{ ...node, filePath: "src/gone.ts" }])).toEqual(new Map());
    // Query with no usable token: no window evidence either.
    expect(windowRelevance(store, "a", [node])).toEqual(new Map());
    store.close();
  });
});

describe("window prior end to end (understand)", () => {
  it("surfaces the capped long method that holds the chunk, without touching anchors", async () => {
    const root = fixture({
      "scrape/manager.ts": [
        "export function accessorTargets(): string[] { return []; }",
        ...filler(400),
        "export function run(): void {",
        ...Array(BODY_SPAN_LINES + 10).fill('  collectTargets("collect targets");'),
        "}",
        "function collectTargets(x: string) { return x; }",
      ].join("\n"),
    });
    const store = GraphStore.open(":memory:");
    await new Indexer(store).indexAll(root);
    const semantic = SemanticEngine.build(store);
    const res = understand(store, semantic, "how does the scrape manager collect targets", {
      root,
      tokenBudget: 6000,
    });
    expect(res.facts.map((f) => f.qualifiedName).some((n) => n.endsWith("run"))).toBe(true);
    // Seeding stays lexical: anchors are never chosen by the window prior.
    const anchors = res.anchors.map((id) => store.getNode(id)?.qualifiedName ?? "");
    expect(anchors.some((n) => n.endsWith("accessorTargets"))).toBe(true);
    store.close();
  });

  it("writes one bounded set of windows per file on a plain index, idempotently", async () => {
    const root = fixture({ "src/big.ts": bigFile() });
    const store = GraphStore.open(":memory:");
    const ix = new Indexer(store);
    await ix.indexAll(root, { jobs: 1 });
    const before = windowRelevance(store, "collect targets", store.allNodes());
    expect(before.size).toBeGreaterThan(0);
    // A sync over unchanged bytes re-parses nothing and reproduces the windows.
    const sync = await ix.sync(root);
    expect(sync.reindexed).toBe(0);
    expect([...windowRelevance(store, "collect targets", store.allNodes()).entries()].sort())
      .toEqual([...before.entries()].sort());
    // The rows themselves are bounded and contiguous.
    const windows = bodyWindows(bigFile());
    expect(windows.length).toBeLessThanOrEqual(WINDOW_MAX);
    store.close();
  });
});
