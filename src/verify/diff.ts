// Unified-diff parsing + in-memory application. Pure string processing, no I/O.
// Parses both `diff --git` (git-generated) and plain `--- `/`+++ ` unified
// diffs (e.g. agent-authored patches feeding the MCP verify tool with no git
// envelope at all) — see splitIntoFileBlocks.

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[]; // lines keep their +/-/space prefix
}

export interface DiffFile {
  path: string; // post-image path (b/ side), "/dev/null" handling folded into deleted
  hunks: DiffHunk[];
  addedRanges: [number, number][]; // post-image [start,end] line ranges of added lines
  deleted: boolean; // b-side is /dev/null
  created: boolean; // a-side is /dev/null
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripPrefix(path: string): string {
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

/**
 * Splits raw diff text into one block of lines per file section. Recognizes
 * two header styles:
 *  - `diff --git a/x b/y` (git-generated diffs)
 *  - plain `--- a/x` / `+++ b/y` (no git envelope — e.g. hand-authored or
 *    patch(1)-style unified diffs)
 * Once a `diff --git` line has been seen, later `--- ` lines are assumed to
 * be that header style's own file markers and are never treated as a new
 * boundary — a `--- ` line only opens a block when no `diff --git` header
 * has appeared yet AND the very next line starts with `+++ ` (a hunk
 * deletion line can itself start with `--- ` — e.g. deleting a SQL/Lua
 * comment "-- foo" renders as "--- foo" — so the `+++ ` lookahead is what
 * disambiguates a real header from hunk content).
 */
function splitIntoFileBlocks(text: string): string[][] {
  const lines = text.split("\n");
  const starts: number[] = [];
  let sawGitHeader = false;
  lines.forEach((l, i) => {
    if (l.startsWith("diff --git ")) {
      sawGitHeader = true;
      starts.push(i);
    } else if (!sawGitHeader && l.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      starts.push(i);
    }
  });
  const blocks: string[][] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i];
    const to = i + 1 < starts.length ? starts[i + 1] : lines.length;
    blocks.push(lines.slice(from, to));
  }
  return blocks;
}

function parseFileBlock(lines: string[]): DiffFile | null {
  let aPath = "";
  let bPath = "";
  let i = 0;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("--- ")) {
      aPath = l.slice(4).trim();
    } else if (l.startsWith("+++ ")) {
      bPath = l.slice(4).trim();
      i++;
      break;
    }
  }
  if (!aPath || !bPath) return null; // no --- /+++ pair (e.g. binary file diff) — skip

  const created = aPath === "/dev/null";
  const deleted = bPath === "/dev/null";
  const path = stripPrefix(deleted ? aPath : bPath);

  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  for (; i < lines.length; i++) {
    const l = lines[i];
    const m = HUNK_HEADER.exec(l);
    if (m) {
      if (cur) hunks.push(cur);
      cur = {
        oldStart: Number(m[1]),
        oldLines: m[2] !== undefined ? Number(m[2]) : 1,
        newStart: Number(m[3]),
        newLines: m[4] !== undefined ? Number(m[4]) : 1,
        lines: [],
      };
    } else if (cur) {
      cur.lines.push(l);
    }
  }
  if (cur) hunks.push(cur);

  return { path, hunks, addedRanges: computeAddedRanges(hunks), deleted, created };
}

/** Post-image [start,end] ranges of added lines, consecutive `+` lines merged. */
function computeAddedRanges(hunks: DiffHunk[]): [number, number][] {
  const ranges: [number, number][] = [];
  for (const hunk of hunks) {
    let counter = hunk.newStart;
    let rangeStart: number | null = null;
    for (const line of hunk.lines) {
      const tag = line[0];
      if (tag === "\\") continue; // "\ No newline at end of file" marker — not a content line, doesn't affect counts
      if (tag === "+") {
        if (rangeStart === null) rangeStart = counter;
        counter++;
        continue;
      }
      if (rangeStart !== null) {
        ranges.push([rangeStart, counter - 1]);
        rangeStart = null;
      }
      // '-' lines don't advance the post-image counter. Context lines do:
      // tag === " " normally, or tag === undefined for a blank context line
      // whose leading space got stripped in transport (empty hunk line).
      if (tag === " " || tag === undefined) counter++;
    }
    if (rangeStart !== null) ranges.push([rangeStart, counter - 1]);
  }
  return ranges;
}

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  for (const block of splitIntoFileBlocks(text)) {
    const file = parseFileBlock(block);
    if (file) files.push(file);
  }
  return files;
}

/**
 * Applies hunks to `original`, verifying context/removal lines match.
 * Trailing-newline handling: split/join symmetrically on "\n" so a trailing
 * newline in `original` (an extra empty trailing element after split) is
 * carried through untouched and reproduced on join. The one exception is
 * `original === ""` (a created file, i.e. no a-side content at all), which is
 * treated as zero lines rather than one empty line — otherwise applying a
 * pure-addition hunk (oldLines: 0) to an empty original would spuriously
 * append a trailing blank line.
 */
export function applyDiff(original: string, hunks: DiffHunk[]): string {
  const origLines = original === "" ? [] : original.split("\n");
  const out: string[] = [];
  let cursor = 0; // 0-based index into origLines, next line not yet copied

  for (const hunk of hunks) {
    const hunkStart = hunk.oldStart - 1; // 0-based
    while (cursor < hunkStart) {
      out.push(origLines[cursor]);
      cursor++;
    }
    for (const line of hunk.lines) {
      const tag = line[0];
      if (tag === "\\") continue; // "\ No newline at end of file" marker — not a content line
      // A blank context line whose leading space got stripped in transport
      // arrives as an empty hunk line (tag undefined); treat it as context.
      const isContext = tag === " " || tag === undefined;
      const content = tag === undefined ? "" : line.slice(1);
      if (isContext || tag === "-") {
        if (origLines[cursor] !== content) {
          throw new Error(`hunk mismatch at line ${cursor + 1}`);
        }
        if (isContext) out.push(content);
        cursor++;
      } else if (tag === "+") {
        out.push(content);
      }
    }
  }
  while (cursor < origLines.length) {
    out.push(origLines[cursor]);
    cursor++;
  }
  return out.join("\n");
}
