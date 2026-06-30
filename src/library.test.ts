import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rinnegan } from "./index.js";

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
});
