import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Veridex } from "../index.js";
import { buildTools } from "./server.js";

describe("MCP tools", () => {
  let root: string;
  let vx: Veridex;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "veridex-mcp-"));
    writeFileSync(
      join(root, "auth.ts"),
      "export function login(u: string){ return validate(u) } function validate(u: string){ return u.length > 0 }",
    );
    vx = Veridex.open(root, { dbPath: ":memory:" });
    await vx.indexAll();
  });
  afterAll(() => {
    vx.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("exposes exactly one listed tool by default (anti tool-overload)", () => {
    const { listed } = buildTools(vx);
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe("understand");
  });

  it("understand tool returns a slice with the anchor symbol", () => {
    const { all } = buildTools(vx);
    const understand = all.find((t) => t.name === "understand")!;
    const text = understand.handler({ task: "user login" });
    expect(text.toLowerCase()).toContain("login");
  });

  it("hidden tools are functional (callers)", () => {
    const { all } = buildTools(vx);
    const callers = all.find((t) => t.name === "callers")!;
    expect(callers.handler({ symbol: "validate" })).toContain("login");
  });
});
