import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { GraphStore } from "../graph/store.js";
import { Indexer } from "../index/indexer.js";
import { SemanticEngine } from "../semantic/engine.js";
import { bodyRelevance, BODY_CHAR_CAP, BODY_SPAN_LINES } from "./body.js";
import { rankNodes } from "./rank.js";
import { understand } from "./understand.js";

const dirs: string[] = [];

/** Fresh temp dir seeded with the given relative-path → content files. */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rinnegan-body-fx-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  dirs.push(dir);
  return dir;
}

/** The same readSource contract `understand()` uses: cached, missing ⇒ undefined. */
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

/** A definition symbol by (suffix of) its qualified name — never a local binding. */
const byName = (store: GraphStore, name: string) => {
  const defs = new Set(["function", "method", "class", "interface", "struct", "type_alias", "enum", "module"]);
  const n = store
    .allNodes()
    .find((x) => defs.has(x.kind) && (x.qualifiedName === name || x.qualifiedName.endsWith(`.${name}`)));
  if (!n) throw new Error(`fixture symbol not indexed: ${name}`);
  return n;
};

afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("symbol body relevance (bodyRelevance)", () => {
  it("scores the body that speaks the task above a same-file accessor that only repeats its name", async () => {
    // `targets` is lexically loud — its NAME is the query word — while `run`
    // says nothing in its name and everything in its body. Name-only ranking
    // cannot separate them; the body prior can.
    const { store, read } = await index({
      "src/scrape.ts": [
        "export function targets() {}",
        "export function run() {",
        "  const targets = collectTargets();",
        "  return targets;",
        "}",
        "function collectTargets() { return []; }",
      ].join("\n"),
    });
    const accessor = byName(store, "targets");
    const worker = byName(store, "run");

    const rel = bodyRelevance("how does the scraper collect targets", [accessor, worker], read);
    expect(rel.get(worker.id)!).toBeGreaterThan(rel.get(accessor.id)!);
    expect(Math.max(...rel.values())).toBe(1); // best own-body score is the scale

    // Equal reported relevance isolates the body prior in the ranker.
    const relevance = new Map([[accessor.id, 1], [worker.id, 1]]);
    const without = rankNodes(store, new Set([accessor.id, worker.id]), relevance, {
      seedIds: new Set([accessor.id]),
    });
    expect(without.map((r) => r.node.id)).toEqual([accessor.id, worker.id]); // tie: input order

    const withBody = rankNodes(store, new Set([accessor.id, worker.id]), relevance, {
      bodyRelevance: rel,
      seedIds: new Set([accessor.id]), // makes the ranker sort (understand always passes seeds)
    });
    expect(withBody[0].node.qualifiedName).toBe("run"); // …and it takes the slice's first slot
    // (1 + 2·b) exactly, on top of the unchanged base score.
    const ratio = withBody[0].score / withBody[1].score;
    expect(ratio).toBeCloseTo((1 + 2 * rel.get(worker.id)!) / (1 + 2 * rel.get(accessor.id)!), 10);
    store.close();
  });

  it("is deterministic: two calls over the same candidates return identical maps", async () => {
    const { store, read } = await index({
      "src/a.ts": ["export function alpha() { return pad(); }", "function pad() { return 1; }"].join("\n"),
      "src/b.ts": ["export function beta() { return alpha(); }"].join("\n"),
    });
    const nodes = store.allNodes();
    const a = bodyRelevance("alpha pad beta", nodes, read);
    const b = bodyRelevance("alpha pad beta", nodes, read);
    expect([...b.entries()]).toEqual([...a.entries()]);
    store.close();
  });

  it("treats an unreadable file as no body — never a throw", async () => {
    const { store, read } = await index({
      "src/present.ts": ["export function present() { return 1; }"].join("\n"),
    });
    const nodes = store.allNodes();
    const missing = read("src/gone.ts"); // never indexed, never on disk
    expect(missing).toBeUndefined();

    const rel = bodyRelevance("present", nodes, read);
    expect(rel.size).toBeGreaterThan(0); // the readable file still scores …
    const nothing = bodyRelevance("present", nodes, () => undefined);
    expect(nothing.size).toBe(0); // … and a fully unreadable corpus is simply empty
    store.close();
  });

  it("clamps a body that runs past EOF instead of reading garbage", async () => {
    const { store } = await index({ "src/short.ts": "export function short() { return 1; }" });
    const node = byName(store, "short");
    const rel = bodyRelevance("short", [node], () => "export function short() { return 1; }");
    expect(rel.get(node.id)).toBe(1);
    // endLine far beyond the file's last line: still the real body, no exception.
    const past = bodyRelevance("short", [{ ...node, startLine: 1, endLine: 40 }], () => "export function short() { return 1; }");
    expect(past.get(node.id)).toBe(1);
    store.close();
  });
});

describe("symbol body caps", () => {
  /** A function of `filler` ~270-char lines, with `tail` appended after them. */
  const giant = (filler: number, tail: string): string => {
    const line = `  const filler = "${"y".repeat(250)}";`;
    return ["export function huge() {", ...Array(filler).fill(line), tail, "}"].join("\n");
  };

  it("ignores body text beyond the character cap (deterministic, not size-dependent)", async () => {
    const inCap = giant(100, "  zebraWrangler();"); // ~27k chars: inside the cap
    const outCap = giant(150, "  zebraWrangler();"); // ~40k chars: past the cap
    const capped = await index({ "src/a.ts": inCap });
    const beyond = await index({ "src/b.ts": outCap });

    const nodeA = byName(capped.store, "huge");
    expect(inCap.indexOf("zebra")).toBeLessThan(BODY_CHAR_CAP);
    expect(outCap.indexOf("zebra")).toBeGreaterThan(BODY_CHAR_CAP);

    expect(bodyRelevance("zebra wrangler", [nodeA], capped.read).get(nodeA.id)).toBe(1);
    const nodeB = byName(beyond.store, "huge");
    expect(bodyRelevance("zebra wrangler", [nodeB], beyond.read).has(nodeB.id)).toBe(false);
    capped.store.close();
    beyond.store.close();
  });

  it("scores a symbol-sized body but never a whole-file section (BODY_SPAN_LINES)", async () => {
    const body = (n: number) => Array(n).fill("  targets.push(collect());");
    const atLimit = ["export function atLimit() {", ...body(BODY_SPAN_LINES - 2), "}"].join("\n");
    const overLimit = ["export function overLimit() {", ...body(BODY_SPAN_LINES), "}"].join("\n");
    const a = await index({ "src/at.ts": atLimit });
    const b = await index({ "src/over.ts": overLimit });

    const at = byName(a.store, "atLimit");
    const over = byName(b.store, "overLimit");
    expect(at.endLine - at.startLine + 1).toBe(BODY_SPAN_LINES);
    expect(over.endLine - over.startLine + 1).toBeGreaterThan(BODY_SPAN_LINES);

    expect(bodyRelevance("collect targets", [at], a.read).get(at.id)).toBe(1);
    expect(bodyRelevance("collect targets", [over], b.read).has(over.id)).toBe(false);
    a.store.close();
    b.store.close();
  });
});

describe("body prior in the ranker", () => {
  it("no map (and an empty map) reproduce the pre-prior scores exactly", async () => {
    const { store } = await index({
      "src/x.ts": ["export function one() { return 1; }", "export function two() { return 2; }"].join("\n"),
      "src/y.ts": ["export function three() { return 3; }"].join("\n"),
    });
    const ids = new Set(store.allNodes().filter((n) => n.kind === "function").map((n) => n.id));
    const relevance = new Map([...ids].map((id) => [id, 0.5]));

    const baseline = rankNodes(store, ids, relevance);
    const omitted = rankNodes(store, ids, relevance, { roles: store.roleByFile() });
    const empty = rankNodes(store, ids, relevance, { roles: store.roleByFile(), bodyRelevance: new Map() });

    const scores = (r: typeof baseline) => new Map(r.map((x) => [x.node.id, x.score]));
    expect(scores(empty)).toEqual(scores(omitted));
    // Same file, same role, same relevance ⇒ every symbol keeps one score.
    expect(new Set([...scores(baseline).values()]).size).toBe(scores(baseline).size > 0 ? 1 : 0);
    expect(omitted.map((r) => r.node.id).sort()).toEqual([...ids].sort());
    store.close();
  });
});

describe("body prior end to end (understand)", () => {
  it("surfaces the method whose body does the work and never re-seeds anchors", async () => {
    const root = fixture({
      "scrape/manager.ts": [
        "export class Manager {",
        "  targets(): string[] { return []; }",
        "  run(): void {",
        "    const targets = this.collectTargets();",
        "    this.updateTargets(targets);",
        "  }",
        "  private collectTargets(): string[] { return []; }",
        "  private updateTargets(t: string[]): void {}",
        "}",
      ].join("\n"),
    });
    const store = GraphStore.open(":memory:");
    await new Indexer(store).indexAll(root);
    const semantic = SemanticEngine.build(store);
    const task = "how does the scrape manager collect targets";

    const res = understand(store, semantic, task, { root, tokenBudget: 4000 });
    const names = res.facts.map((f) => f.qualifiedName);
    expect(names.some((n) => n.endsWith("run"))).toBe(true);
    const anchors = res.anchors.map((id) => store.getNode(id)?.qualifiedName ?? "");
    expect(anchors.some((n) => n.endsWith("targets"))).toBe(true); // seeding stays lexical
    store.close();
  });

  it("does not throw when a candidate's source file has been deleted", async () => {
    const root = fixture({
      "scrape/manager.ts": [
        "export function run() {",
        "  const targets = collectTargets();",
        "  return targets;",
        "}",
        "function collectTargets() { return []; }",
      ].join("\n"),
    });
    const store = GraphStore.open(":memory:");
    await new Indexer(store).indexAll(root);
    const semantic = SemanticEngine.build(store);
    unlinkSync(join(root, "scrape/manager.ts")); // indexed but no longer on disk

    const res = understand(store, semantic, "collect targets", { root, tokenBudget: 2000 });
    expect(res.text).toContain("scrape/manager.ts"); // falls back to the signature line
    expect(res.text.length).toBeGreaterThan(0);
    store.close();
  });
});
