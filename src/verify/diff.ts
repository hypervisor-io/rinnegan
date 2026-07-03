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
 * Given the index right after a hunk's `@@ -o,n +s,m @@` header line, plus
 * the header's declared old/new line counts, returns the index of the first
 * line after the hunk body. Consumes lines until `oldLines` old-side lines
 * (`-` or context) and `newLines` new-side lines (`+` or context) have both
 * been seen. A context line is a ` `-prefixed line or a fully empty line
 * (blank context whose leading space got stripped in transport) and counts
 * toward both sides; a `\` marker line ("\ No newline at end of file") is
 * consumed but counts toward neither.
 *
 * This makes hunk bodies opaque to line-prefix boundary checks elsewhere: a
 * `--- `/`+++ ` pair that happens to appear *inside* a hunk body (e.g.
 * deleting "-- foo" and adding "++ bar" back-to-back renders as the raw
 * lines "--- foo" / "+++ bar") is body content consumed by count here, not
 * inspected for header-ness.
 */
function hunkBodyEnd(lines: string[], start: number, oldLines: number, newLines: number): number {
  let oldSeen = 0;
  let newSeen = 0;
  let i = start;
  while (i < lines.length && (oldSeen < oldLines || newSeen < newLines)) {
    const tag = lines[i][0];
    if (tag === "-") oldSeen++;
    else if (tag === "+") newSeen++;
    else if (tag !== "\\") {
      oldSeen++;
      newSeen++;
    }
    i++;
  }
  return i;
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
 * has appeared yet, the very next line starts with `+++ `, and the line
 * after that starts with `@@ ` (a real plain file section is always
 * `---`/`+++`/`@@`).
 *
 * Boundary detection only ever runs BETWEEN hunks: whenever a `@@ ... @@`
 * header is seen, the scan jumps straight past its declared body (via
 * hunkBodyEnd) instead of inspecting body lines one by one, so a hunk-body
 * line that happens to look like a `--- `/`+++ ` header pair can never be
 * mistaken for one.
 */
function splitIntoFileBlocks(text: string): string[][] {
  const lines = text.split("\n");
  const starts: number[] = [];
  let sawGitHeader = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    const hunkMatch = HUNK_HEADER.exec(l);
    if (hunkMatch) {
      const oldLines = hunkMatch[2] !== undefined ? Number(hunkMatch[2]) : 1;
      const newLines = hunkMatch[4] !== undefined ? Number(hunkMatch[4]) : 1;
      i = hunkBodyEnd(lines, i + 1, oldLines, newLines);
      continue;
    }
    if (l.startsWith("diff --git ")) {
      sawGitHeader = true;
      starts.push(i);
    } else if (
      !sawGitHeader &&
      l.startsWith("--- ") &&
      lines[i + 1]?.startsWith("+++ ") &&
      lines[i + 2]?.startsWith("@@ ")
    ) {
      starts.push(i);
    }
    i++;
  }
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
  for (; i < lines.length; i++) {
    const m = HUNK_HEADER.exec(lines[i]);
    if (!m) continue; // between hunks — nothing to do until the next header
    const oldLines = m[2] !== undefined ? Number(m[2]) : 1;
    const newLines = m[4] !== undefined ? Number(m[4]) : 1;
    const bodyStart = i + 1;
    const bodyEnd = hunkBodyEnd(lines, bodyStart, oldLines, newLines);
    hunks.push({
      oldStart: Number(m[1]),
      oldLines,
      newStart: Number(m[3]),
      newLines,
      lines: lines.slice(bodyStart, bodyEnd),
    });
    i = bodyEnd - 1; // loop's i++ lands exactly on the next header (or past the end)
  }

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
