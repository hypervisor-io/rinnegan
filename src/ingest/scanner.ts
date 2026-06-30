import { execFileSync } from "node:child_process";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, extname, basename, sep } from "node:path";
import { createHash } from "node:crypto";

/** Extension → language. Drives which files are considered source. */
export const LANG_EXT: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".go": "go",
};

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "vendor", "target",
  ".veridex", "coverage", ".next", ".nuxt", ".cache", "__pycache__",
]);

const MAX_BYTES = 1_000_000;

export interface ScannedFile {
  path: string; // relative to root, POSIX-ish (uses OS sep)
  size: number;
  language: string;
}

export function contentHash(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function isMinified(name: string): boolean {
  return /\.(min|bundle)\.(js|css|mjs|cjs)$/.test(name) || /\.min\./.test(name);
}

function languageOf(path: string): string | undefined {
  return LANG_EXT[extname(path).toLowerCase()];
}

function accept(absPath: string, size: number): string | undefined {
  if (size > MAX_BYTES) return undefined;
  if (isMinified(basename(absPath))) return undefined;
  return languageOf(absPath);
}

/** Try git's file list (tracked + untracked, gitignore-respected). */
function gitFiles(root: string): string[] | undefined {
  if (!existsSync(join(root, ".git"))) return undefined;
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-co", "--exclude-standard"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split("\n").filter(Boolean);
  } catch {
    return undefined;
  }
}

function walk(root: string, dir: string, acc: string[]): void {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith(".") && ent.name !== ".env") {
      // skip dotfiles/dirs except a few; .git already excluded
      if (ent.isDirectory()) continue;
    }
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (IGNORE_DIRS.has(ent.name)) continue;
      walk(root, abs, acc);
    } else if (ent.isFile()) {
      acc.push(relative(root, abs));
    }
  }
}

/**
 * Enumerate source files under root. Git-first (respects .gitignore), else a
 * filtered directory walk. Deterministic: result sorted by path.
 */
export function scanFiles(root: string): ScannedFile[] {
  let rels = gitFiles(root);
  if (!rels) {
    const acc: string[] = [];
    walk(root, root, acc);
    rels = acc;
  } else {
    // git may list files under ignored dirs via -o rarely; filter defensively
    rels = rels.filter((r) => !r.split(sep).some((seg) => IGNORE_DIRS.has(seg)));
  }

  const out: ScannedFile[] = [];
  for (const rel of rels) {
    const abs = join(root, rel);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue; // listed but missing (e.g. deleted, untracked race)
    }
    if (!st.isFile()) continue;
    const lang = accept(abs, st.size);
    if (!lang) continue;
    out.push({ path: rel, size: st.size, language: lang });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
