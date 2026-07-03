import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { Rinnegan, freshnessStamp, renderLookup, renderVerify, type SyncStats, type VerifyInput } from "../index.js";
import { renderMapMarkdown, renderMapMermaid } from "../domains/render.js";
import { parseUnifiedDiff } from "../verify/diff.js";
import { VERSION } from "../version.js";

type Out = (s: string) => void;

function openIndexed(root: string): Rinnegan {
  return Rinnegan.open(root);
}

/** Build VerifyInput[] straight from the git index: paths + addedRanges from
 * `git diff --cached`, post-images from `git show :<path>` (fails for a
 * staged deletion — that's the null postImage the report expects). */
function stagedInputs(root: string): VerifyInput[] {
  if (!existsSync(join(root, ".git"))) {
    throw new Error("not a git repository — use --diff <patch>");
  }
  const diffText = execFileSync("git", ["-C", root, "diff", "--cached", "--unified=0"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseUnifiedDiff(diffText).map((f) => {
    let postImage: string | null = null;
    try {
      postImage = execFileSync("git", ["-C", root, "show", `:${f.path}`], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"], // a staged deletion makes this fail — expected, not worth a scary stderr line
      });
    } catch {
      // staged deletion (or otherwise unreadable from the index) — null postImage
    }
    return { path: f.path, postImage, addedRanges: f.addedRanges };
  });
}

/** Reconcile the index with the working tree before answering. Never answer stale. */
async function ensureIndexed(vx: Rinnegan): Promise<SyncStats> {
  if (vx.stats().nodes === 0) {
    await vx.indexAll();
    return { reindexed: 0, removed: 0 };
  }
  return vx.refresh();
}

/** Build the commander program. `out` and `cwd` are injectable for testing. */
export function buildProgram(out: Out, cwd: string): Command {
  const program = new Command();
  program.name("rinnegan").description("Verifiable code-knowledge engine").version(VERSION);
  program.option("--json", "machine-readable JSON output (for agents/scripts)");
  program.option("-C, --root <dir>", "project root to operate on (default: cwd)");
  const json = () => !!program.opts().json;
  const dir = (): string => (program.opts().root as string | undefined) ?? cwd;

  program
    .command("index [path]")
    .description("Build/update the index")
    .action(async (path?: string) => {
      const vx = Rinnegan.open(path ?? dir());
      const stats = await vx.indexAll();
      out(json() ? JSON.stringify(stats) : `Indexed ${stats.parsed} file(s), ${stats.nodes} nodes, ${stats.edges} edges (${stats.skipped} unchanged).`);
      vx.close();
    });

  program
    .command("status")
    .description("Show index statistics")
    .action(() => {
      const vx = Rinnegan.open(dir());
      const s = vx.stats();
      out(json() ? JSON.stringify(s) : `nodes=${s.nodes} edges=${s.edges} files=${s.files}`);
      vx.close();
    });

  program
    .command("inventory")
    .description("Per-file inventory: role, language, symbols, inbound edges, orphan status")
    .action(async () => {
      const vx = openIndexed(dir());
      await ensureIndexed(vx);
      const rows = vx.inventory();
      out(
        json()
          ? rows.map((r) => JSON.stringify(r)).join("\n")
          : rows
              .map((r) => `${r.path}  ${r.role}  ${r.language}  symbols=${r.symbols}  in=${r.inboundEdges}${r.orphaned ? " [orphaned]" : ""}`)
              .join("\n"),
      );
      vx.close();
    });

  program
    .command("understand <task...>")
    .description("Return the minimal, provenance-tagged signal slice for a task")
    .option("-b, --budget <n>", "token budget", "6000")
    .option("-s, --scope <domain>", "restrict the slice to one domain (see `rinnegan map`)")
    .action(async (task: string[], opts: { budget: string; scope?: string }) => {
      const vx = openIndexed(dir());
      const fresh = await ensureIndexed(vx);
      const res = vx.understand(task.join(" "), { tokenBudget: Number(opts.budget), scope: opts.scope });
      out(
        json()
          ? JSON.stringify({ tokensEstimate: res.tokensEstimate, anchors: res.anchors, text: res.text, fresh })
          : [freshnessStamp(fresh), res.text].join("\n"),
      );
      vx.close();
    });

  program
    .command("verify")
    .description("Graph-native fact-check of a diff: unknown symbols, signature echo, blast radius")
    .option("--staged", "verify the git index (staged changes) instead of a diff")
    .option("--diff <file>", "unified diff to verify ('-' reads stdin)")
    .option("--allow <names...>", "symbol names to allow (suppress unknown-symbol findings)")
    .action(async (opts: { staged?: boolean; diff?: string; allow?: string[] }) => {
      if (!opts.staged && !opts.diff) throw new Error("verify requires --staged or --diff <file|->");
      const root = dir();
      const inputs = opts.staged ? stagedInputs(root) : undefined;
      const diffText = inputs ? undefined : opts.diff === "-" ? readFileSync(0, "utf8") : readFileSync(opts.diff!, "utf8");

      const vx = openIndexed(root);
      await ensureIndexed(vx);
      const report = inputs ? await vx.verifyInputs(inputs, { allow: opts.allow }) : await vx.verify(diffText!, { allow: opts.allow });
      out(json() ? JSON.stringify(report) : renderVerify(report));
      if (report.findings.some((f) => f.severity === "error")) process.exitCode = 1;
      vx.close();
    });

  program
    .command("search <query...>")
    .description("Symbol search (FTS/BM25)")
    .action(async (query: string[]) => {
      const vx = openIndexed(dir());
      await ensureIndexed(vx);
      const hits = vx.search(query.join(" "), 20);
      out(json() ? JSON.stringify(hits) : hits.map((n) => `${n.filePath}:${n.startLine}  ${n.qualifiedName}  [${n.kind}]`).join("\n"));
      vx.close();
    });

  program
    .command("deps <file>")
    .description("File-scoped dependency query")
    .action(async (file: string) => {
      const vx = openIndexed(dir());
      await ensureIndexed(vx);
      const d = vx.deps(file);
      out(json() ? JSON.stringify(d) : d.dependencies.map((x) => `${x.name}  [${x.provenance}/${x.kind}]`).join("\n") || "(none)");
      vx.close();
    });

  program
    .command("refs <symbol>")
    .description("References to a symbol")
    .option("--write", "writes only")
    .option("--read", "reads only")
    .action(async (symbol: string, opts: { write?: boolean; read?: boolean }) => {
      const vx = openIndexed(dir());
      await ensureIndexed(vx);
      const rw = opts.write ? "write" : opts.read ? "read" : undefined;
      const refs = vx.refs(symbol, rw ? { readWrite: rw } : {});
      out(json() ? JSON.stringify(refs) : refs.map((e) => `${e.line}  ${e.readWrite}  <- ${vx.resolveSymbol(symbol)?.qualifiedName ?? symbol}`).join("\n") || "(none)");
      vx.close();
    });

  program
    .command("callers <symbol>")
    .description("Functions that call a symbol")
    .action(async (symbol: string) => {
      const vx = openIndexed(dir());
      await ensureIndexed(vx);
      const c = vx.callers(symbol);
      out(json() ? JSON.stringify(c) : c.map((n) => `${n.filePath}:${n.startLine}  ${n.qualifiedName}`).join("\n") || "(none)");
      vx.close();
    });

  program
    .command("tests <symbol>")
    .description("Tests that exercise a symbol")
    .action(async (symbol: string) => {
      const vx = openIndexed(dir());
      await ensureIndexed(vx);
      const t = vx.testsFor(symbol);
      out(json() ? JSON.stringify(t) : t.map((n) => `${n.filePath}:${n.startLine}  ${n.qualifiedName}`).join("\n") || "(none)");
      vx.close();
    });

  program
    .command("lookup <name>")
    .description("Exact symbol fact, or an explicit NOT FOUND")
    .action(async (name: string) => {
      const vx = openIndexed(dir());
      await ensureIndexed(vx);
      const r = vx.lookup(name);
      out(json() ? JSON.stringify(r) : renderLookup(r));
      vx.close();
    });

  program
    .command("impact <symbol>")
    .description("Blast radius of changing a symbol")
    .action(async (symbol: string) => {
      const vx = openIndexed(dir());
      await ensureIndexed(vx);
      const i = vx.impact(symbol);
      out(json() ? JSON.stringify(i) : i.map((n) => `${n.filePath}:${n.startLine}  ${n.qualifiedName}`).join("\n") || "(none)");
      vx.close();
    });

  program
    .command("docs")
    .description("Doc-mention checks against the graph")
    .option("--stale", "list inline-code doc mentions with no matching symbol")
    .action(async (opts: { stale?: boolean }) => {
      if (!opts.stale) {
        out("rinnegan docs --stale   # list doc mentions that no longer match any symbol (only mode for now)");
        return;
      }
      const vx = openIndexed(dir());
      await ensureIndexed(vx);
      const rows = vx.staleDocs();
      out(
        json()
          ? JSON.stringify(rows)
          : rows.map((r) => `${r.docPath}:${r.line}  mentions '${r.name}' — no such symbol`).join("\n") || "(none)",
      );
      vx.close();
    });

  program
    .command("map")
    .description("Architecture map: domains, entrypoints, top symbols, inter-domain dependencies")
    .option("--mermaid", "render as a mermaid flowchart instead of markdown")
    .action(async (opts: { mermaid?: boolean }) => {
      const vx = openIndexed(dir());
      await ensureIndexed(vx);
      const m = vx.map();
      out(json() ? JSON.stringify(m) : opts.mermaid ? renderMapMermaid(m) : renderMapMarkdown(m));
      vx.close();
    });

  program
    .command("watch")
    .description("Index, then keep the index live as files change")
    .action(async () => {
      const vx = openIndexed(dir());
      await ensureIndexed(vx);
      out("Watching for changes (Ctrl-C to stop)...");
      vx.watch((e) => out(`${e.result}: ${e.path}`));
      await new Promise(() => {}); // run until interrupted
    });

  program
    .command("install [agent]")
    .description("Print MCP config to connect Rinnegan to a coding agent (claude-code, cursor, codex, kiro, pi, windsurf, gemini)")
    .action(async (agent?: string) => {
      const { renderInstall } = await import("../mcp/install.js");
      // prefer a global `rinnegan` binary; fall back to this entry's absolute path
      const cmd = process.env.RINNEGAN_BIN ?? "rinnegan";
      out(renderInstall(agent, cmd, ["mcp"]));
    });

  program
    .command("mcp")
    .description("Start the MCP server over stdio (understand, lookup, verify)")
    .action(async () => {
      const { runMcp } = await import("../mcp/server.js");
      await runMcp(dir());
    });

  return program;
}

/** Run the CLI. Returns when the chosen command completes. */
export async function runCli(argv: string[], out: Out = console.log, cwd: string = process.cwd()): Promise<void> {
  await buildProgram(out, cwd).parseAsync(argv, { from: "user" });
}

// Entry when executed directly.
const invokedDirectly = process.argv[1]?.endsWith("main.ts") || process.argv[1]?.endsWith("main.js") || process.argv[1]?.endsWith("rinnegan.js");
if (invokedDirectly) {
  runCli(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
