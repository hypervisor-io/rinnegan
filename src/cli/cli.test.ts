import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./main.js";

describe("CLI", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "veridex-cli-"));
    writeFileSync(
      join(root, "auth.ts"),
      "export function login(u: string){ return validate(u) } function validate(u: string){ return u.length > 0 }",
    );
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("index then understand prints a slice with the anchor symbol", async () => {
    const lines: string[] = [];
    await runCli(["index"], (s) => lines.push(s), root);
    expect(lines.join("\n")).toMatch(/Indexed/);

    lines.length = 0;
    await runCli(["understand", "user", "login"], (s) => lines.push(s), root);
    expect(lines.join("\n").toLowerCase()).toContain("login");
  });

  it("callers command works", async () => {
    const lines: string[] = [];
    await runCli(["callers", "validate"], (s) => lines.push(s), root);
    expect(lines.join("\n")).toContain("login");
  });

  it("--json produces parseable output", async () => {
    const lines: string[] = [];
    await runCli(["--json", "status"], (s) => lines.push(s), root);
    expect(() => JSON.parse(lines.join(""))).not.toThrow();
  });
});
