import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { classifyFile, buildClassifyContext } from "./classify.js";

const fixtureDirs: string[] = [];
/** Fresh temp dir seeded with the given relative-path → content files. */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rinnegan-classify-"));
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  fixtureDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of fixtureDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ctx = { entryTargets: new Set(["src/cli/main.ts"]), manifestDirs: new Set([""]) };
const c = (p: string, src = "", lang = "typescript", imp: string[] = []) => classifyFile(p, src, lang, imp, ctx);

describe("classifyFile", () => {
  it("precedence order", () => {
    expect(c("third_party/x.test.ts")).toBe("vendored");            // vendored beats test
    expect(c("a.test.ts", "// @generated")).toBe("generated");      // generated beats test
  });
  it("each rule", () => {
    expect(c("third_party/lib.ts")).toBe("vendored");
    expect(c("gen.ts", "// DO NOT EDIT\n")).toBe("generated");
    expect(c("src/a.test.ts")).toBe("test");
    expect(c("tests/helper.ts")).toBe("test");
    expect(c("src/util.ts", "", "typescript", ["vitest"])).toBe("test");
    expect(c("src/cli/main.ts")).toBe("entrypoint");                // manifest target
    expect(c("run.sh", "#!/usr/bin/env bash\n", "bash")).toBe("entrypoint");
    expect(c("index.ts")).toBe("entrypoint");                       // index.* at package root
    expect(c("vite.config.ts")).toBe("config");
    expect(c("package.json", "{}", "manifest")).toBe("config");
    expect(c("README.md", "", "markdown")).toBe("doc");
    expect(c("src/graph/store.ts")).toBe("library");
  });
  it("test frameworks are scoped per-language — a TS import of a module literally named 'testing' isn't a test signal", () => {
    expect(c("src/util.ts", "", "typescript", ["testing"])).toBe("library"); // "testing" is Go stdlib, not a JS test framework
    expect(c("src/main.go", "", "go", ["testing"])).toBe("test");            // but it is one for Go
  });
  it("buildClassifyContext reads package.json bin/main/exports", () => {
    const root = fixture({ "package.json": JSON.stringify({ main: "./dist/index.js", bin: { x: "./bin/x.js" } }) });
    const ctx2 = buildClassifyContext(root, ["package.json"]);
    expect(ctx2.entryTargets.has("dist/index.js")).toBe(true);
    expect(ctx2.entryTargets.has("bin/x.js")).toBe(true);
    expect(ctx2.manifestDirs.has("")).toBe(true);
  });
  it("buildClassifyContext normalizes windows-style manifest path separators", () => {
    const root = fixture({ "packages/foo/package.json": JSON.stringify({ main: "./lib/index.js" }) });
    const ctx2 = buildClassifyContext(root, ["packages\\foo\\package.json"]);
    expect(ctx2.entryTargets.has("packages/foo/lib/index.js")).toBe(true);
    expect(ctx2.manifestDirs.has("packages/foo")).toBe(true);
    expect(ctx2.manifestDirs.has("")).toBe(false);
  });
});
