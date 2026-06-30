import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanFiles, contentHash } from "./scanner.js";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "veridex-scan-"));
  writeFileSync(join(root, "a.ts"), "export const a = 1;");
  writeFileSync(join(root, "b.py"), "x = 1");
  writeFileSync(join(root, "vendor.min.js"), "var z=1");
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(root, "node_modules", "dep", "index.js"), "module.exports={}");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "deep.ts"), "export const d = 2;");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("scanFiles", () => {
  it("includes source, excludes node_modules and minified", () => {
    const files = scanFiles(root).map((f) => f.path.replace(/\\/g, "/"));
    expect(files).toContain("a.ts");
    expect(files).toContain("b.py");
    expect(files).toContain("src/deep.ts");
    expect(files.some((p) => p.includes("node_modules"))).toBe(false);
    expect(files).not.toContain("vendor.min.js");
  });

  it("tags language and is deterministic", () => {
    const a = scanFiles(root);
    const b = scanFiles(root);
    expect(a).toEqual(b);
    expect(a.find((f) => f.path.endsWith("a.ts"))?.language).toBe("typescript");
  });

  it("contentHash is stable", () => {
    expect(contentHash("hello")).toBe(contentHash("hello"));
    expect(contentHash("hello")).not.toBe(contentHash("world"));
  });
});
