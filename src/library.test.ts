import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rinnegan, freshnessStamp, renderLookup } from "./index.js";

const fixtureDirs: string[] = [];

/** Fresh temp dir seeded with the given relative-path → content files. */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rinnegan-lib-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  fixtureDirs.push(dir);
  return dir;
}

describe("Rinnegan library", () => {
  let root: string;
  let vx: Rinnegan;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "rinnegan-lib-"));
    writeFileSync(
      join(root, "auth.ts"),
      [
        "export function login(user: string) {",
        "  let attempts = 0;",
        "  attempts = attempts + 1;",
        "  return validate(user, attempts);",
        "}",
        "function validate(u: string, n: number) {",
        "  return u.length > 0;",
        "}",
      ].join("\n"),
    );
    vx = Rinnegan.open(root, { dbPath: ":memory:" });
    await vx.indexAll();
  });
  afterAll(() => {
    vx.close();
    rmSync(root, { recursive: true, force: true });
    for (const d of fixtureDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("understand returns a relevant slice", () => {
    const r = vx.understand("login validation");
    expect(r.text.toLowerCase()).toContain("login");
  });

  it("callers finds login as a caller of validate", () => {
    const callers = vx.callers("validate").map((n) => n.qualifiedName);
    expect(callers).toContain("login");
  });

  it("refs with readWrite=write finds the attempts assignment", () => {
    const writes = vx.refs("attempts", { readWrite: "write" });
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((e) => e.readWrite === "write")).toBe(true);
  });

  it("impact of validate includes login", () => {
    expect(vx.impact("validate").map((n) => n.qualifiedName)).toContain("login");
  });

  it("refresh picks up an edit so understand cites current facts", async () => {
    // ponytail: fixture names use "alpha"/"beta" (not the brief's literal oldName/newName) —
    // GraphStore.searchFts OR-matches sub-tokens, so "oldName" would false-positive-match a
    // renamed "newName" node via their shared "name" token. Verified via direct repro that
    // refresh() itself fully removes the old node (search("old"-only-token) is empty); this
    // is a pre-existing FTS recall-over-precision quirk, out of scope for this task.
    const root = fixture({ "a.ts": "export function alpha() {}" });
    const vx = Rinnegan.open(root, { dbPath: ":memory:" });
    await vx.indexAll();
    writeFileSync(join(root, "a.ts"), "export function beta() {}");
    const t = Date.now() + 5000;
    utimesSync(join(root, "a.ts"), new Date(t), new Date(t));
    const s = await vx.refresh();
    expect(s.reindexed).toBe(1);
    expect(vx.search("beta").length).toBeGreaterThan(0);
    expect(vx.search("alpha").length).toBe(0);
  });

  it("freshnessStamp wording", () => {
    expect(freshnessStamp({ reindexed: 0, removed: 0 })).toBe("# index: fresh");
    expect(freshnessStamp({ reindexed: 2, removed: 1 })).toBe("# index: 2 file(s) reindexed, 1 removed just now");
  });

  it("lookup finds validate with signature, location, and caller count", () => {
    const r = vx.lookup("validate");
    expect(r.found).toBe(true);
    if (!r.found) throw new Error("expected found");
    expect(r.node.qualifiedName).toBe("validate");
    expect(r.node.kind).toBe("function");
    expect(r.node.filePath).toBe("auth.ts");
    expect(r.node.startLine).toBe(6);
    expect(r.callers).toBe(1);
    expect(renderLookup(r)).toBe(
      `validate  [function]\n${r.node.signature}\nauth.ts:6\ncallers: 1`,
    );
  });

  it("lookup on a missing symbol returns the exact NOT FOUND sentence and at most 3 suggestions", () => {
    const r = vx.lookup("zzzNoSuchSymbolAnywhere");
    expect(r.found).toBe(false);
    if (r.found) throw new Error("expected not found");
    expect(r.message).toBe(
      "NOT FOUND — no symbol named 'zzzNoSuchSymbolAnywhere' exists in this codebase. Do not invent it.",
    );
    expect(r.suggestions.length).toBeLessThanOrEqual(3);
    expect(renderLookup(r)).toContain(r.message);
  });

  it("lookup prefers an exact qualifiedName match over a dotted-suffix match", () => {
    const root2 = fixture({
      "outer.ts": [
        "export class Widget {",
        "  target() { return 1; }",
        "}",
        "export function target() { return 2; }",
      ].join("\n"),
    });
    const vx2 = Rinnegan.open(root2, { dbPath: ":memory:" });
    return vx2.indexAll().then(() => {
      const r = vx2.lookup("target");
      vx2.close();
      expect(r.found).toBe(true);
      if (!r.found) throw new Error("expected found");
      expect(r.node.qualifiedName).toBe("target"); // exact match, not "Widget.target"
    });
  });

  it("inventory: entrypoint with zero inbound is not orphaned, unused file is orphaned, used file has inbound edges", async () => {
    // ponytail: identifiers kept subtoken-disjoint (runB/bootMain vs idleC) per the FTS quirk noted elsewhere in this file.
    const root = fixture({
      "package.json": JSON.stringify({ main: "./entry.ts" }),
      "entry.ts": `import { runB } from "./used";\nexport function bootMain() { return runB(); }`,
      "used.ts": `export function runB() { return 1; }`,
      "unused.ts": `export function idleC() { return 2; }`,
    });
    const vx2 = Rinnegan.open(root, { dbPath: ":memory:" });
    await vx2.indexAll();
    const rows = vx2.inventory();
    vx2.close();

    expect(rows.map((r) => r.path)).toEqual(["entry.ts", "package.json", "unused.ts", "used.ts"]);

    const byPath = new Map(rows.map((r) => [r.path, r]));
    expect(byPath.get("entry.ts")?.role).toBe("entrypoint");
    expect(byPath.get("entry.ts")?.inboundEdges).toBe(0);
    expect(byPath.get("entry.ts")?.orphaned).toBe(false);

    expect(byPath.get("used.ts")?.inboundEdges).toBeGreaterThan(0);
    expect(byPath.get("used.ts")?.orphaned).toBe(false);

    expect(byPath.get("unused.ts")?.inboundEdges).toBe(0);
    expect(byPath.get("unused.ts")?.orphaned).toBe(true);
  });
});
