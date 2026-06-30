import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Veridex } from "../index.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "veridex-watch-"));
  writeFileSync(join(root, "a.ts"), `export function alpha(){ return 1 }`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("incremental reindex", () => {
  it("reindexFile picks up a new symbol after an edit", async () => {
    const vx = Veridex.open(root, { dbPath: ":memory:" });
    await vx.indexAll();
    expect(vx.search("beta").length).toBe(0);

    writeFileSync(join(root, "a.ts"), `export function alpha(){ return 1 }\nexport function beta(){ return 2 }`);
    const r = await vx.reindexFile("a.ts");
    expect(r).toBe("reindexed");
    expect(vx.search("beta").some((n) => n.qualifiedName === "beta")).toBe(true);
    vx.close();
  });

  it("reindexFile removes symbols when the file is deleted", async () => {
    const vx = Veridex.open(root, { dbPath: ":memory:" });
    await vx.indexAll();
    rmSync(join(root, "a.ts"));
    const r = await vx.reindexFile("a.ts");
    expect(r).toBe("removed");
    expect(vx.search("alpha").length).toBe(0);
    vx.close();
  });
});
