import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../graph/store.js";
import { Indexer } from "../index/indexer.js";
import { resolveModulePath, type FileExistsLookup } from "./module_path.js";

/** Minimal FileExistsLookup backed by a fixed set of indexed paths. */
function fakeStore(files: string[]): FileExistsLookup {
  const set = new Set(files);
  return { fileExists: (p) => set.has(p) };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rinnegan-imp-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("cross-file import resolution", () => {
  it("resolves a call to a named imported function as ast_inferred", async () => {
    writeFileSync(join(root, "validate.ts"), `export function validateAmount(a: number){ return a > 0 }`);
    writeFileSync(
      join(root, "pay.ts"),
      `import { validateAmount } from "./validate";\nexport function pay(a: number){ return validateAmount(a) }`,
    );
    const store = GraphStore.open(":memory:");
    await new Indexer(store).indexAll(root);

    const crossCall = store
      .allEdges()
      .find((e) => e.kind === "calls" && e.metadata?.crossFile === true);
    expect(crossCall).toBeTruthy();
    expect(crossCall!.provenance).toBe("ast_inferred");
    const target = store.getNode(crossCall!.target);
    expect(target?.qualifiedName).toBe("validateAmount");
    expect(target?.filePath.replace(/\\/g, "/")).toBe("validate.ts");
    store.close();
  });

  it("leaves bare/external imports unresolved (honest)", async () => {
    writeFileSync(join(root, "x.ts"), `import { readFileSync } from "node:fs";\nexport function r(){ return readFileSync("a") }`);
    const store = GraphStore.open(":memory:");
    await new Indexer(store).indexAll(root);
    expect(store.allEdges().some((e) => e.kind === "calls" && e.provenance === "unresolved")).toBe(true);
    store.close();
  });

  it("resolves a call across a NodeNext .js-spec import", async () => {
    writeFileSync(join(root, "a.ts"), `export function fn(){ return 1 }`);
    writeFileSync(join(root, "b.ts"), `import { fn } from "./a.js";\nexport function callIt(){ return fn() }`);
    const store = GraphStore.open(":memory:");
    await new Indexer(store).indexAll(root);

    const crossCall = store.allEdges().find((e) => e.kind === "calls" && e.metadata?.crossFile === true);
    expect(crossCall).toBeTruthy();
    expect(crossCall!.provenance).toBe("ast_inferred");
    const target = store.getNode(crossCall!.target);
    expect(target?.qualifiedName).toBe("fn");
    expect(target?.filePath.replace(/\\/g, "/")).toBe("a.ts");
    store.close();
  });
});

describe("resolveModulePath — NodeNext .js/.mjs/.cjs/.jsx specifier remapping", () => {
  it("maps a .js specifier to the sibling .ts source (mandatory NodeNext spelling)", () => {
    const store = fakeStore(["src/store.ts"]);
    expect(resolveModulePath("src/a.ts", "./store.js", store)).toBe("src/store.ts");
  });

  it("maps a .mjs specifier to the sibling .mts source", () => {
    const store = fakeStore(["src/store.mts"]);
    expect(resolveModulePath("src/a.ts", "./store.mjs", store)).toBe("src/store.mts");
  });

  it("prefers a literal .js file over the remapped .ts when both are indexed", () => {
    const store = fakeStore(["src/x.js", "src/x.ts"]);
    expect(resolveModulePath("src/a.ts", "./x.js", store)).toBe("src/x.js");
  });
});
