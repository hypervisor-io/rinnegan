import { describe, it, expect } from "vitest";
import { parseUnifiedDiff, applyDiff } from "./diff.js";

// Hand-written diff covering: an edited file (two hunks), a new file, a deletion.
// Fixtures deliberately have NO trailing newline — keeps split("\n") line counts
// matching the hunk arithmetic exactly (see comment in diff.ts re: trailing newlines).
const ORIGINAL_A = [
  "line1", "line2", "line3", "line4", "line5",
  "line6", "line7", "line8", "line9", "line10",
].join("\n");

const EXPECTED_A = [
  "line1", "line2-changed", "line3", "line4", "line5",
  "line6", "line7", "line8", "line9-changed", "line9b", "line10",
].join("\n");

const DIFF_TEXT = [
  "diff --git a/a.txt b/a.txt",
  "index 1111111..2222222 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1,4 +1,4 @@",
  " line1",
  "-line2",
  "+line2-changed",
  " line3",
  " line4",
  "@@ -7,4 +7,5 @@",
  " line7",
  " line8",
  "-line9",
  "+line9-changed",
  "+line9b",
  " line10",
  "diff --git a/new.txt b/new.txt",
  "new file mode 100644",
  "index 0000000..4444444",
  "--- /dev/null",
  "+++ b/new.txt",
  "@@ -0,0 +1,3 @@",
  "+newline1",
  "+newline2",
  "+newline3",
  "diff --git a/old.txt b/old.txt",
  "deleted file mode 100644",
  "index 3333333..0000000",
  "--- a/old.txt",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-oldline1",
  "-oldline2",
].join("\n");

describe("parseUnifiedDiff", () => {
  const files = parseUnifiedDiff(DIFF_TEXT);

  it("parses three file entries in order", () => {
    expect(files.map((f) => f.path)).toEqual(["a.txt", "new.txt", "old.txt"]);
  });

  it("edited file: two hunks, not created/deleted, merged addedRanges", () => {
    const f = files[0];
    expect(f.created).toBe(false);
    expect(f.deleted).toBe(false);
    expect(f.hunks).toHaveLength(2);
    expect(f.addedRanges).toEqual([[2, 2], [9, 10]]);
  });

  it("new file: created true, addedRanges spans whole file", () => {
    const f = files[1];
    expect(f.created).toBe(true);
    expect(f.deleted).toBe(false);
    expect(f.addedRanges).toEqual([[1, 3]]);
  });

  it("deleted file: deleted true, path kept from a-side, no added lines", () => {
    const f = files[2];
    expect(f.created).toBe(false);
    expect(f.deleted).toBe(true);
    expect(f.path).toBe("old.txt");
    expect(f.addedRanges).toEqual([]);
  });
});

describe("applyDiff", () => {
  it("applies two hunks to produce the exact post-image", () => {
    const files = parseUnifiedDiff(DIFF_TEXT);
    const result = applyDiff(ORIGINAL_A, files[0].hunks);
    expect(result).toBe(EXPECTED_A);
  });

  it("applies a hunk that creates a brand new file (empty original)", () => {
    const files = parseUnifiedDiff(DIFF_TEXT);
    const result = applyDiff("", files[1].hunks);
    expect(result).toBe(["newline1", "newline2", "newline3"].join("\n"));
  });

  it("throws a precise mismatch error when context/removal lines don't match original", () => {
    const files = parseUnifiedDiff(DIFF_TEXT);
    const corrupted = ORIGINAL_A.replace("line8", "lineBAD");
    expect(() => applyDiff(corrupted, files[0].hunks)).toThrow("hunk mismatch at line 8");
  });
});
