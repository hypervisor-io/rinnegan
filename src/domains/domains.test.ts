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

async function buildStore(): Promise<GraphStore> {
  const root = fixture(FILES);
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
