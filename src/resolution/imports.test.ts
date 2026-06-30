import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../graph/store.js";
import { Indexer } from "../index/indexer.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "veridex-imp-"));
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
});
