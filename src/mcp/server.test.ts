import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rinnegan, freshnessStamp } from "../index.js";
import { buildTools } from "./server.js";

const fixtureDirs: string[] = [];

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

  it("exposes exactly one listed tool by default (anti tool-overload)", () => {
    const { listed } = buildTools(vx);
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe("understand");
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
  });
});
