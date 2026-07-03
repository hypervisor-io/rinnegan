import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rinnegan } from "../index.js";

let root: string;
let vx: Rinnegan;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "rinnegan-verify-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "third_party"));
  writeFileSync(
    join(root, "src/api.ts"),
    ["export function realFn(a: string) {", "  return a;", "}"].join("\n"),
  );
  writeFileSync(join(root, "src/caller.ts"), 'import { realFn } from "./api";');
  // Separate pre-existing caller of realFn, used only by the blast-radius
  // test — keeps caller.ts's own added call (per-test, via diffAdding) from
  // colliding with the extractor's same-owner/same-target edge dedup (its
  // pushEdge key ignores line number, so two calls to realFn from the same
  // top-level scope would collapse into one edge and hide the added one).
  writeFileSync(
    join(root, "src/consumer.ts"),
    ['import { realFn } from "./api";', 'realFn("y");'].join("\n"),
  );
  writeFileSync(join(root, "third_party/lib.ts"), "export function libFn() {}");
  vx = Rinnegan.open(root, { dbPath: ":memory:" });
  await vx.indexAll();
});

afterAll(() => {
  vx.close();
  rmSync(root, { recursive: true, force: true });
});

/**
 * Fabricates a valid one-hunk plain unified diff appending `line` as a new
 * last line to the current on-disk fixture content at `path`. Context is the
 * last up-to-3 existing lines (kept unchanged by the fixtures across tests,
 * so the on-disk read here always matches the original hunk arithmetic).
 */
function diffAdding(path: string, line: string): string {
  const content = readFileSync(join(root, path), "utf8");
  const lines = content.split("\n");
  const n = lines.length;
  const ctxCount = Math.min(3, n);
  const ctx = lines.slice(n - ctxCount);
  const oldStart = n - ctxCount + 1;
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${oldStart},${ctxCount} +${oldStart},${ctxCount + 1} @@`,
    ...ctx.map((l) => ` ${l}`),
    `+${line}`,
  ].join("\n");
}

describe("Rinnegan.verify", () => {
  it("flags a call to a nonexistent symbol as error", async () => {
    const rep = await vx.verify(diffAdding("src/caller.ts", "notReal();"));
    expect(
      rep.findings.some(
        (f) => f.rule === "unknown-symbol" && f.severity === "error" && /notReal/.test(f.message),
      ),
    ).toBe(true);
  });

  it("echoes ground-truth signature for a resolved call", async () => {
    const rep = await vx.verify(diffAdding("src/caller.ts", 'realFn("x");'));
    const f = rep.findings.find((x) => x.rule === "signature-echo");
    expect(f).toBeTruthy();
    expect(f!.message).toContain("realFn(a: string)");
    expect(f!.message).toContain("src/api.ts:");
  });

  it("flags a second call to an already-called target on its own added line (F1: per-call-site edges)", async () => {
    // consumer.ts already calls realFn("y") once (line 2); this diff adds a
    // second call to the SAME target from the SAME owner scope on line 3. Before
    // the fix, the extractor's dedup key ignored line number, so the reparsed
    // post-image collapsed both calls into one edge at line 2 — outside the
    // added range — and the added call went unseen (false negative).
    const rep = await vx.verify(diffAdding("src/consumer.ts", 'realFn("x");'));
    const f = rep.findings.find((x) => x.rule === "signature-echo" && x.line === 3);
    expect(f).toBeTruthy();
    expect(f!.message).toContain("realFn(a: string)");
  });

  it("warns blast radius when a called definition is edited", async () => {
    const diff = [
      "--- a/src/api.ts",
      "+++ b/src/api.ts",
      "@@ -1,3 +1,3 @@",
      " export function realFn(a: string) {",
      "-  return a;",
      "+  return String(a);",
      " }",
    ].join("\n");
    const rep = await vx.verify(diff);
    const f = rep.findings.find((x) => x.rule === "blast-radius");
    expect(f).toBeTruthy();
    expect(f!.severity).toBe("warn");
    expect(f!.message).toContain("src/consumer.ts");
  });

  it("reports unparseable post-image as parse-failure error", async () => {
    // TS is error-tolerant (never yields zero nodes); use a fresh tree-sitter
    // (python) file whose content is not python at all — zero defs, zero edges.
    const diff = [
      "--- /dev/null",
      "+++ b/src/broken.py",
      "@@ -0,0 +1,1 @@",
      "+!!!not python!!!",
    ].join("\n");
    const rep = await vx.verify(diff);
    expect(
      rep.findings.some(
        (f) => f.rule === "parse-failure" && f.severity === "error" && f.file === "src/broken.py",
      ),
    ).toBe(true);
  });

  it("never mutates the on-disk store (rollback proof)", async () => {
    const before = vx.stats();
    await vx.verify(diffAdding("src/caller.ts", "notReal();"));
    expect(vx.stats()).toEqual(before);
  });

  it("skips vendored/generated files", async () => {
    const rep = await vx.verify(diffAdding("third_party/lib.ts", "notReal();"));
    expect(rep.skipped).toEqual(["third_party/lib.ts"]);
    expect(rep.findings).toEqual([]);
  });

  it("--allow suppresses a named unknown symbol", async () => {
    const rep = await vx.verify(diffAdding("src/caller.ts", "notReal();"), { allow: ["notReal"] });
    expect(rep.findings.some((f) => /notReal/.test(f.message))).toBe(false);
  });
});
