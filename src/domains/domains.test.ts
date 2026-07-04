import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { GraphStore } from "../graph/store.js";
import { Indexer } from "../index/indexer.js";
import { computeDomains } from "./domains.js";

const fixtureDirs: string[] = [];

/** Fresh temp dir seeded with the given relative-path → content files. */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rinnegan-dom-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  fixtureDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of fixtureDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Two auth files + one billing file + a root entrypoint that imports both.
// main.ts calls two symbols from charge.ts (weight 2) but only one from
// login.ts (weight 1), so main lands in the billing camp on ties — which
// keeps charge.ts from being engulfed into the auth domain.
const FILES = {
  "package.json": JSON.stringify({ main: "./main.ts" }),
  "main.ts": [
    `import { login } from "./src/auth/login";`,
    `import { chargeCard, refundCard } from "./src/billing/charge";`,
    `export function main() { login(); chargeCard(); refundCard(); }`,
  ].join("\n"),
  "src/auth/token.ts": `export function mintToken() { return "t"; }`,
  "src/auth/login.ts": [
    `import { mintToken } from "./token";`,
    `export function login() { return mintToken(); }`,
  ].join("\n"),
  "src/billing/charge.ts": [
    `import { mintToken } from "../auth/token";`,
    `export function chargeCard() { return mintToken(); }`,
    `export function refundCard() { return 0; }`,
  ].join("\n"),
};

async function buildStore(files: Record<string, string> = FILES): Promise<GraphStore> {
  const root = fixture(files);
  const store = GraphStore.open(":memory:");
  await new Indexer(store).indexAll(root);
  return store;
}

describe("computeDomains", () => {
  it("groups auth files together and links billing → auth with weight ≥ 1", async () => {
    const store = await buildStore();
    const { domains, edges } = computeDomains(store);
    store.close();

    expect(domains.length).toBeGreaterThanOrEqual(2);

    const authDomain = domains.find((d) => d.files.includes("src/auth/login.ts"));
    const billingDomain = domains.find((d) => d.files.includes("src/billing/charge.ts"));
    expect(authDomain).toBeTruthy();
    expect(billingDomain).toBeTruthy();
    expect(authDomain!.files).toContain("src/auth/token.ts");
    expect(authDomain!.name).not.toBe(billingDomain!.name);

    const crossEdge = edges.find((e) => e.from === billingDomain!.name && e.to === authDomain!.name);
    expect(crossEdge).toBeTruthy();
    expect(crossEdge!.weight).toBeGreaterThanOrEqual(1);

    // domains sorted by name, files within a domain sorted, edges sorted by (from, to)
    expect(domains.map((d) => d.name)).toEqual([...domains.map((d) => d.name)].sort());
    for (const d of domains) expect(d.files).toEqual([...d.files].sort());
    for (let i = 1; i < edges.length; i++) {
      const prev = edges[i - 1], cur = edges[i];
      expect(prev.from < cur.from || (prev.from === cur.from && prev.to <= cur.to)).toBe(true);
    }
  });

  // Regression for a domain-name collision: propagation can land two different final
  // labels on domains that both fall back to the same commonDirPrefix name (here "src",
  // since both {a,b} and {c,d} span two top-level dirs and share only "src"). Edge
  // aggregation must key on the label pair, not the rendered name — otherwise a real
  // cross-domain edge (b -> c below) gets treated as a same-domain edge and dropped.
  it("keeps a cross-domain edge even when the two domains render to the same name", async () => {
    const store = await buildStore({
      "package.json": JSON.stringify({ main: "./src/d0/a.ts" }),
      "src/d0/a.ts": [
        `import { fn_b } from "../d1/b";`,
        `export function fn_a1() { return fn_b(); }`,
        `export function fn_a2() { return fn_b(); }`,
      ].join("\n"),
      "src/d1/b.ts": [
        `import { fn_c1 } from "../d2/c";`,
        `export function fn_b() { return fn_c1(); }`,
      ].join("\n"),
      "src/d2/c.ts": [
        `import { fn_d } from "../d3/d";`,
        `export function fn_c1() { return fn_d(); }`,
        `export function fn_c2() { return fn_d(); }`,
      ].join("\n"),
      "src/d3/d.ts": [`export function fn_d() { return 1; }`].join("\n"),
    });
    const { domains, edges } = computeDomains(store);
    store.close();

    const srcDomains = domains.filter((d) => d.name === "src");
    expect(srcDomains).toHaveLength(2); // two distinct labels, same rendered name: the collision
    const groupA = srcDomains.find((d) => d.files.includes("src/d1/b.ts"))!;
    const groupB = srcDomains.find((d) => d.files.includes("src/d2/c.ts"))!;
    expect(groupA).not.toBe(groupB);
    expect(groupA.label).not.toBe(groupB.label); // distinct labels are what renderers must route on

    // The real b -> c cross-domain edge must survive despite from === to === "src".
    const crossEdge = edges.find((e) => e.from === "src" && e.to === "src");
    expect(crossEdge).toBeTruthy();
    expect(crossEdge!.weight).toBe(1);
    // and it must carry the two distinct labels, not just the collided names
    expect(crossEdge!.fromLabel).toBe(groupA.label);
    expect(crossEdge!.toLabel).toBe(groupB.label);
  });

  it("is deterministic: byte-identical across two computeDomains calls on a rebuilt store", async () => {
    const store1 = await buildStore();
    const result1 = computeDomains(store1);
    store1.close();

    const store2 = await buildStore();
    const result2 = computeDomains(store2);
    store2.close();

    expect(JSON.stringify(result1)).toBe(JSON.stringify(result2));
  });
});
