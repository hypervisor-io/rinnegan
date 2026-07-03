import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runCli } from "./main.js";

const fixtureDirs: string[] = [];

/** Fresh temp dir seeded with the given relative-path → content files (nested paths welcome). */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rinnegan-cli-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
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

  it("tests command prints the covering test file's location; --json emits the node array", async () => {
    const dir = fixture({
      "src/pay.ts": "export function charge() { return 1; }",
      "src/pay.test.ts": ["import { charge } from \"./pay\";", "charge();"].join("\n"),
    });
    await runCli(["index"], () => {}, dir);

    const lines: string[] = [];
    await runCli(["tests", "charge"], (s) => lines.push(s), dir);
    expect(lines.join("\n")).toContain("src/pay.test.ts");

    const jsonLines: string[] = [];
    await runCli(["--json", "tests", "charge"], (s) => jsonLines.push(s), dir);
    const arr = JSON.parse(jsonLines.join("")) as { filePath: string }[];
    expect(arr.some((n) => n.filePath === "src/pay.test.ts")).toBe(true);
  });

  it("tests command prints (none) for a symbol with no covering test", async () => {
    const dir = fixture({ "src/pay.ts": "export function charge() { return 1; }" });
    await runCli(["index"], () => {}, dir);

    const lines: string[] = [];
    await runCli(["tests", "charge"], (s) => lines.push(s), dir);
    expect(lines.join("\n")).toBe("(none)");
  });

  it("lookup command prints renderLookup output for a found symbol", async () => {
    const lines: string[] = [];
    await runCli(["lookup", "validate"], (s) => lines.push(s), root);
    const text = lines.join("\n");
    expect(text).toContain("validate  [function]");
    expect(text).toContain("callers: 1");
  });

  it("lookup --json prints the LookupResult for a missing symbol", async () => {
    const lines: string[] = [];
    await runCli(["--json", "lookup", "zzzNoSuchSymbolAnywhere"], (s) => lines.push(s), root);
    const r = JSON.parse(lines.join(""));
    expect(r.found).toBe(false);
    expect(r.message).toBe(
      "NOT FOUND — no symbol named 'zzzNoSuchSymbolAnywhere' exists in this codebase. Do not invent it.",
    );
  });

  it("--json produces parseable output", async () => {
    const lines: string[] = [];
    await runCli(["--json", "status"], (s) => lines.push(s), root);
    expect(() => JSON.parse(lines.join(""))).not.toThrow();
  });

  it("inventory --json emits one parseable JSON object per line; plain mode marks orphaned files", async () => {
    // ponytail: identifiers kept subtoken-disjoint (runB/bootMain vs idleC) per the FTS quirk noted elsewhere.
    const dir = fixture({
      "package.json": JSON.stringify({ main: "./entry.ts" }),
      "entry.ts": `import { runB } from "./used";\nexport function bootMain() { return runB(); }`,
      "used.ts": `export function runB() { return 1; }`,
      "unused.ts": `export function idleC() { return 2; }`,
    });
    await runCli(["index"], () => {}, dir);

    const jsonLines: string[] = [];
    await runCli(["--json", "inventory"], (s) => jsonLines.push(s), dir);
    const rows = jsonLines
      .join("\n")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(rows.length).toBe(4);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(["inboundEdges", "language", "orphaned", "path", "role", "symbols"].sort());
    }
    expect(rows.find((r) => r.path === "unused.ts")?.orphaned).toBe(true);
    expect(rows.find((r) => r.path === "entry.ts")?.orphaned).toBe(false);

    const plainLines: string[] = [];
    await runCli(["inventory"], (s) => plainLines.push(s), dir);
    const plainText = plainLines.join("\n");
    expect(plainText).toContain("unused.ts  library  typescript  symbols=1  in=0 [orphaned]");
    expect(plainText).not.toMatch(/entry\.ts.*\[orphaned\]/);
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

  it("verify --diff flags a call to a nonexistent symbol and sets exit code 1", async () => {
    const dir = fixture({ "svc.ts": "export function orbit(x){ return x }\n" });
    await runCli(["index"], () => {}, dir);
    writeFileSync(
      join(dir, "bad.patch"),
      ["--- a/svc.ts", "+++ b/svc.ts", "@@ -1,1 +1,2 @@", " export function orbit(x){ return x }", "+phantom();"].join("\n"),
    );

    const lines: string[] = [];
    process.exitCode = 0;
    await runCli(["verify", "--diff", join(dir, "bad.patch")], (s) => lines.push(s), dir);
    expect(lines.join("\n")).toContain("unknown-symbol");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0; // reset — this test deliberately triggers the exit-1 path
  });

  it("verify --diff on a clean patch reports 0 errors and leaves exit code untouched", async () => {
    const dir = fixture({ "lib.ts": "export function orbit(x){ return x }\n" });
    await runCli(["index"], () => {}, dir);
    writeFileSync(
      join(dir, "clean.patch"),
      ["--- a/lib.ts", "+++ b/lib.ts", "@@ -1,1 +1,2 @@", " export function orbit(x){ return x }", "+orbit(1);"].join("\n"),
    );

    const lines: string[] = [];
    process.exitCode = 0;
    await runCli(["verify", "--diff", join(dir, "clean.patch")], (s) => lines.push(s), dir);
    expect(lines.join("\n")).toContain("0 error(s)");
    expect(process.exitCode).toBe(0);
  });

  it("verify --staged outside a git repo errors and names --diff", async () => {
    const dir = fixture({ "solo.ts": "export function orbit(x){ return x }\n" });
    await expect(runCli(["verify", "--staged"], () => {}, dir)).rejects.toThrow(/--diff/);
  });

  it("map prints domain markdown with entrypoints, top symbols, and dependency edges", async () => {
    // ponytail: identifiers kept subtoken-disjoint (bootMain/login/mintTok/chargeCard) per the FTS quirk noted above.
    const dir = fixture({
      "package.json": JSON.stringify({ main: "./main.ts" }),
      "main.ts": [
        `import { login } from "./src/auth/login";`,
        `import { chargeCard, refundCard } from "./src/billing/charge";`,
        `export function bootMain() { login(); chargeCard(); refundCard(); }`,
      ].join("\n"),
      "src/auth/token.ts": `export function mintTok() { return "t"; }`,
      "src/auth/login.ts": [`import { mintTok } from "./token";`, `export function login() { return mintTok(); }`].join("\n"),
      "src/billing/charge.ts": [
        `import { mintTok } from "../auth/token";`,
        `export function chargeCard() { return mintTok(); }`,
        `export function refundCard() { return 0; }`,
      ].join("\n"),
    });
    await runCli(["index"], () => {}, dir);

    const mdLines: string[] = [];
    await runCli(["map"], (s) => mdLines.push(s), dir);
    const text = mdLines.join("\n");
    expect(text).toMatch(/^## /m);
    expect(text).toContain("entrypoints: main.ts");
    expect(text).toMatch(/- \S+ — \S+:\d+/);
    expect(text).toContain("## dependencies");
    expect(text).toMatch(/\S+ → \S+ \(\d+\)/);

    const mermaidLines: string[] = [];
    await runCli(["map", "--mermaid"], (s) => mermaidLines.push(s), dir);
    const mermaid = mermaidLines.join("\n");
    expect(mermaid.split("\n")[0]).toBe("flowchart LR");
    expect(mermaid).toMatch(/-->\|\d+\|/);

    const jsonLines: string[] = [];
    await runCli(["map", "--json"], (s) => jsonLines.push(s), dir);
    const m = JSON.parse(jsonLines.join(""));
    expect(Array.isArray(m.domains)).toBe(true);
    expect(Array.isArray(m.edges)).toBe(true);
    expect(m.domains.every((d: { topSymbols: unknown[] }) => Array.isArray(d.topSymbols))).toBe(true);
  });

  it("docs --stale lists inline-code mentions that no longer match a symbol; plain docs prints a usage hint", async () => {
    const dir = fixture({
      "src/api.ts": "export function realFn() { return 1; }",
      "docs/x.md": "Use `realFn` and `goneFn` for tasks.",
    });
    await runCli(["index"], () => {}, dir);

    const lines: string[] = [];
    await runCli(["docs", "--stale"], (s) => lines.push(s), dir);
    expect(lines.join("\n")).toContain("docs/x.md:1  mentions 'goneFn' — no such symbol");

    const jsonLines: string[] = [];
    await runCli(["--json", "docs", "--stale"], (s) => jsonLines.push(s), dir);
    expect(JSON.parse(jsonLines.join(""))).toEqual([{ docPath: "docs/x.md", line: 1, name: "goneFn" }]);

    const hintLines: string[] = [];
    await runCli(["docs"], (s) => hintLines.push(s), dir);
    expect(hintLines.join("\n")).toContain("--stale");
  });

  it("verify --staged reads the git index directly (edited + deleted files)", async () => {
    const dir = fixture({});
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["-C", dir, "config", "user.email", "test@rinnegan.dev"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "rinnegan-test"]);
    writeFileSync(join(dir, "mod.ts"), "export function nimbus(x){ return x }\n");
    writeFileSync(join(dir, "drop.ts"), "export function ember(){ return 1 }\n");
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "init"]);

    await runCli(["index"], () => {}, dir);

    writeFileSync(join(dir, "mod.ts"), "export function nimbus(x){ return x }\nwisp();\n");
    execFileSync("git", ["-C", dir, "add", "mod.ts"]);
    execFileSync("git", ["-C", dir, "rm", "-q", "--cached", "drop.ts"]);

    const lines: string[] = [];
    process.exitCode = 0;
    await runCli(["verify", "--staged"], (s) => lines.push(s), dir);
    const text = lines.join("\n");
    expect(text).toContain("unknown-symbol");
    expect(text).toContain("wisp");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0; // reset — this test deliberately triggers the exit-1 path
  });
});
