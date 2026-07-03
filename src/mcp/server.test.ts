import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, utimesSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rinnegan, freshnessStamp } from "../index.js";
import { buildTools } from "./server.js";

const fixtureDirs: string[] = [];

/**
 * Fabricates a valid one-hunk plain unified diff appending `line` as a new
 * last line of the on-disk fixture at `path` (mirrors verify.test.ts's helper
 * of the same name).
 */
function diffAdding(root: string, path: string, line: string): string {
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

/** Fresh temp dir seeded with the given relative-path → content files. */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rinnegan-mcp-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  fixtureDirs.push(dir);
  return dir;
}

describe("MCP tools", () => {
  let root: string;
  let vx: Rinnegan;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "rinnegan-mcp-"));
    writeFileSync(
      join(root, "auth.ts"),
      "export function login(u: string){ return validate(u) } function validate(u: string){ return u.length > 0 }",
    );
    vx = Rinnegan.open(root, { dbPath: ":memory:" });
    await vx.indexAll();
  });
  afterAll(() => {
    vx.close();
    rmSync(root, { recursive: true, force: true });
    for (const d of fixtureDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("exposes exactly [understand, lookup, verify, map] by default (anti tool-overload)", () => {
    const { listed } = buildTools(vx);
    expect(listed.map((t) => t.name)).toEqual(["understand", "lookup", "verify", "map"]);
  });

  it("map tool returns markdown with a domain header and a dependencies section", () => {
    const { all } = buildTools(vx);
    const map = all.find((t) => t.name === "map")!;
    const text = map.handler({}, "") as string;
    expect(text).toMatch(/^## /m);
    expect(text).toContain("## dependencies");
  });

  it("understand tool returns a slice with the anchor symbol", () => {
    const { all } = buildTools(vx);
    const understand = all.find((t) => t.name === "understand")!;
    const text = understand.handler({ task: "user login" }, "");
    expect(text.toLowerCase()).toContain("login");
  });

  it("hidden tools are functional (callers)", () => {
    const { all } = buildTools(vx);
    const callers = all.find((t) => t.name === "callers")!;
    expect(callers.handler({ symbol: "validate" }, "")).toContain("login");
  });

  it("lookup tool round-trips a found symbol and an explicit NOT FOUND", () => {
    const { all } = buildTools(vx);
    const lookup = all.find((t) => t.name === "lookup")!;
    const found = lookup.handler({ name: "login" }, "") as string;
    expect(found).toContain("login");
    expect(found).toContain("callers:");
    const notFound = lookup.handler({ name: "doesNotExist" }, "") as string;
    expect(notFound).toContain("NOT FOUND");
  });

  it("verify tool flags an unknown symbol from a diff string", async () => {
    const { all } = buildTools(vx);
    const verify = all.find((t) => t.name === "verify")!;
    const diff = diffAdding(root, "auth.ts", "notReal();");
    const text = await verify.handler({ diff }, "");
    expect(text).toContain("notReal");
    expect(text).toContain("error");
  });

  it("tool calls see post-edit facts and stamp freshness", async () => {
    const root = fixture({ "a.ts": "export function alpha() {}" });
    const vx = Rinnegan.open(root, { dbPath: ":memory:" });
    await vx.indexAll();
    writeFileSync(join(root, "a.ts"), "export function beta() {}");
    const t = Date.now() + 5000;
    utimesSync(join(root, "a.ts"), new Date(t), new Date(t));
    // dispatch the way the request handler will: refresh first, then handler(args, stamp)
    const stamp = freshnessStamp(await vx.refresh());
    const { all } = buildTools(vx);
    const text = await all.find((t) => t.name === "understand")!.handler({ task: "beta" }, stamp);
    expect(text.split("\n")[0]).toMatch(/^# index: /);
    expect(text).toContain("beta");
    expect(text).not.toContain("alpha");
    vx.close();
  });
});
