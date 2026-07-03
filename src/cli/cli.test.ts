import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./main.js";

const fixtureDirs: string[] = [];

/** Fresh temp dir seeded with the given relative-path → content files. */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rinnegan-cli-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  fixtureDirs.push(dir);
  return dir;
}

describe("CLI", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rinnegan-cli-"));
    writeFileSync(
      join(root, "auth.ts"),
      "export function login(u: string){ return validate(u) } function validate(u: string){ return u.length > 0 }",
    );
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    for (const d of fixtureDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

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

  it("understand answers from a reconciled index and stamps freshness", async () => {
    const dir = fixture({ "a.ts": "export function alpha() {}" });
    await runCli(["index"], () => {}, dir);
    writeFileSync(join(dir, "a.ts"), "export function beta() {}");
    const t = Date.now() + 5000;
    utimesSync(join(dir, "a.ts"), new Date(t), new Date(t));

    const lines: string[] = [];
    await runCli(["understand", "beta"], (s) => lines.push(s), dir);
    const text = lines.join("\n");
    expect(text.split("\n")[0]).toMatch(/^# index: /);
    expect(text).toContain("beta");
    expect(text).not.toContain("alpha");
  });
});
